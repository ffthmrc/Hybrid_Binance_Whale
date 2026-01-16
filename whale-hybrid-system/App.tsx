import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { SymbolData, Position, TradingAlert, StrategyConfig, AccountState, Side, TradeHistoryItem } from './types';
import { DEFAULT_CONFIG } from './constants.tsx';
import MarketOverview from './components/MarketOverview';
import TradingChart from './components/TradingChart';
import TradingControls from './components/TradingControls';
import AlertsPanel from './components/AlertsPanel';
import PositionsPanel from './components/PositionsPanel';
import { fetchAllData } from './utils/api';
import { SYSTEM_CONFIG } from './config';

const FEE_RATE = 0.0005;
const MAX_HISTORY = 500;
const MAX_ALERTS = 1000; // 6 saat için yeterli

interface PumpTracker {
  minuteVolumes: number[];
  lastPumpAlert: number;
  minuteStartVolume: number;
  currentMinute: number;
}

interface Candle {
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  minute: number;
}

interface CandidateData {
  symbol: string;
  fetchedAt: number;
  klines1m: any[];
  klines5m: any[];
  recentTrades: any[];
  openInterest: number | null;
  fundingRate: number | null;
  support: number;
  resistance: number;
  avgTradeSize: number;
  buyPressure: number;
}

type MobileTab = 'market' | 'alerts' | 'chart' | 'positions' | 'controls';

const App: React.FC = () => {
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');
  const [marketData, setMarketData] = useState<Record<string, SymbolData>>({});
  const [tempTrends, setTempTrends] = useState<Record<string, 'up' | 'down' | null>>({});
  const [positions, setPositions] = useState<Position[]>([]);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryItem[]>([]);
  const [alerts, setAlerts] = useState<TradingAlert[]>([]);
  const [config, setConfig] = useState<StrategyConfig>(DEFAULT_CONFIG);
  const [account, setAccount] = useState<AccountState>({
    balance: 10000,
    equity: 10000,
    dailyLoss: 0, 
    lastTradeTimestamp: 0,
    initialBalance: 10000
  });

  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth1, setRightWidth1] = useState(300);
  const [rightWidth2, setRightWidth2] = useState(320);
  const [bottomHeight, setBottomHeight] = useState(320);
  const isResizing = useRef<string | null>(null);

  const processedAlertIds = useRef<Set<string>>(new Set());
  const candleOpenPricesRef = useRef<Record<string, { price: number; minute: number }>>({});
  const candleHistoryRef = useRef<Record<string, Candle[]>>({});
  const lastAlertDataRef = useRef<Record<string, { time: number; change: number }>>({});
  const rollingHistoryRef = useRef<Record<string, { prices: number[], volumes: number[] }>>({});
  const trendTimeoutsRef = useRef<Record<string, any>>({});
  
  const pumpTrackerRef = useRef<Record<string, PumpTracker>>({});
  const lastQuoteVolumeRef = useRef<Record<string, number>>({});
  
  // Hybrid sistem için candidate data cache
  const candidateDataRef = useRef<Record<string, CandidateData>>({});
  const fetchingSymbolsRef = useRef<Set<string>>(new Set());

  const isBlacklisted = useCallback((symbol: string) => {
    if (!symbol) return false;
    const cleanSymbol = symbol.toUpperCase().replace('USDT', '').trim();
    return config.blacklist.some(b => b.toUpperCase().replace('USDT', '').trim() === cleanSymbol);
  }, [config.blacklist]);

  // Hybrid: Aday coin için detaylı veri çek
  const fetchCandidateData = useCallback(async (symbol: string) => {
    if (fetchingSymbolsRef.current.has(symbol)) return null;
    
    const cached = candidateDataRef.current[symbol];
    if (cached && Date.now() - cached.fetchedAt < 60000) {
      return cached; // 1 dakika cache
    }

    fetchingSymbolsRef.current.add(symbol);
    
    try {
      console.log(`[Hybrid] 🔍 Fetching detailed data for ${symbol}...`);
      const data = await fetchAllData(symbol);
      
      // Support/Resistance hesapla
      const closes = data.klines5m.map((k: any) => k.close);
      const support = Math.min(...closes.slice(-10));
      const resistance = Math.max(...closes.slice(-10));
      
      // Trade analizi
      const totalTradeSize = data.recentTrades.reduce((sum: number, t: any) => sum + t.quoteQty, 0);
      const avgTradeSize = totalTradeSize / (data.recentTrades.length || 1);
      
      let buyVolume = 0, sellVolume = 0;
      data.recentTrades.forEach((t: any) => {
        if (t.isBuyerMaker) sellVolume += t.quoteQty;
        else buyVolume += t.quoteQty;
      });
      const buyPressure = buyVolume / (buyVolume + sellVolume || 1);

      const candidateData: CandidateData = {
        symbol,
        fetchedAt: Date.now(),
        klines1m: data.klines1m,
        klines5m: data.klines5m,
        recentTrades: data.recentTrades,
        openInterest: data.openInterest,
        fundingRate: data.fundingRate,
        support,
        resistance,
        avgTradeSize,
        buyPressure
      };
      
      candidateDataRef.current[symbol] = candidateData;
      console.log(`[Hybrid] ✅ ${symbol} data ready - S:${support.toFixed(6)} R:${resistance.toFixed(6)} BuyP:${(buyPressure*100).toFixed(1)}%`);
      
      return candidateData;
    } catch (error) {
      console.error(`[Hybrid] ❌ Failed to fetch ${symbol}:`, error);
      return null;
    } finally {
      fetchingSymbolsRef.current.delete(symbol);
    }
  }, []);

  // GEVŞETİLMİŞ PUMP DETECTION
  const checkPumpStart = useCallback((
    symbol: string, 
    price: number, 
    tickVolume: number,
    priceChangePct: number
  ): { isPump: boolean; volumeRatio: number } => {
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    
    if (!pumpTrackerRef.current[symbol]) {
      pumpTrackerRef.current[symbol] = {
        minuteVolumes: [],
        lastPumpAlert: 0,
        minuteStartVolume: 0,
        currentMinute
      };
    }
    
    const tracker = pumpTrackerRef.current[symbol];
    
    if (tracker.currentMinute !== currentMinute) {
      tracker.minuteVolumes.push(tracker.minuteStartVolume);
      if (tracker.minuteVolumes.length > 20) tracker.minuteVolumes.shift();
      tracker.minuteStartVolume = 0;
      tracker.currentMinute = currentMinute;
    }
    
    tracker.minuteStartVolume += tickVolume;
    
    // Config'den alınan değer: PUMP.PRICE_CHANGE_MIN
    const priceCondition = Math.abs(priceChangePct) >= SYSTEM_CONFIG.PUMP.PRICE_CHANGE_MIN;
    let volumeCondition = false;
    let volumeRatio = 0;
    
    if (tracker.minuteVolumes.length >= 2) {
      const lastMinuteVolume = tracker.minuteVolumes[tracker.minuteVolumes.length - 1];
      const currentVolume = tracker.minuteStartVolume;
      
      // Config'den alınan değer: PUMP.VOLUME_RATIO_MIN
      const condition1 = currentVolume > lastMinuteVolume * SYSTEM_CONFIG.PUMP.VOLUME_RATIO_MIN;
      
      let condition2 = false;
      if (tracker.minuteVolumes.length >= 5) {
        const last5Avg = tracker.minuteVolumes.slice(-5).reduce((a,b) => a+b, 0) / 5;
        // Config'den alınan değer: PUMP.VOLUME_RATIO_5M_AVG
        condition2 = currentVolume > last5Avg * SYSTEM_CONFIG.PUMP.VOLUME_RATIO_5M_AVG;
      }
      
      let condition3 = false;
      if (tracker.minuteVolumes.length >= 10) {
        const avg10 = tracker.minuteVolumes.slice(-10).reduce((a,b) => a+b, 0) / 10;
        // Config'den alınan değer: PUMP.VOLUME_RATIO_10M_AVG
        condition3 = currentVolume > avg10 * SYSTEM_CONFIG.PUMP.VOLUME_RATIO_10M_AVG;
      }
      
      volumeCondition = condition1 || condition2 || condition3;
      volumeRatio = lastMinuteVolume > 0 ? currentVolume / lastMinuteVolume : 0;
    }
    
    // Config'den alınan değer: PUMP.COOLDOWN_MS
    const spamCheck = (now - tracker.lastPumpAlert) > SYSTEM_CONFIG.PUMP.COOLDOWN_MS; 
    const isPump = priceCondition && volumeCondition && spamCheck;
    if (isPump) tracker.lastPumpAlert = now;
    
    return { isPump, volumeRatio };
  }, []);

  // GEVŞETİLMİŞ TREND START DETECTION
  const checkTrendStart = useCallback((
    symbol: string,
    currentPrice: number,
    candleChangePct: number
  ): { isTrendStart: boolean; details: any } => {
    const candles = candleHistoryRef.current[symbol] || [];
    
    // Config'den alınan değer: TREND.MIN_CANDLES
    if (candles.length < SYSTEM_CONFIG.TREND.MIN_CANDLES) {
      return { isTrendStart: false, details: { reason: 'INSUFFICIENT_DATA', candleCount: candles.length } };
    }

    // 1. KONSOLİDASYON KONTROLÜ (Son 10 mum)
    const last10Candles = candles.slice(-20);
    const closes = last10Candles.map(c => c.close);
    const priceRange = Math.max(...closes) - Math.min(...closes);
    const avgPrice = closes.reduce((a, b) => a + b) / closes.length;
    const rangePercent = (priceRange / avgPrice) * 100;
    
    // Config'den alınan değer: TREND.CONSOLIDATION_MAX
    const isConsolidating = rangePercent < SYSTEM_CONFIG.TREND.CONSOLIDATION_MAX;
    
    if (!isConsolidating) {
      return { isTrendStart: false, details: { reason: 'NO_CONSOLIDATION', range: rangePercent.toFixed(2) } };
    }

    // 2. BREAKOUT KONTROLÜ
    // Config'den alınan değer: TREND.BREAKOUT_MIN
    const isBreakout = Math.abs(candleChangePct) >= SYSTEM_CONFIG.TREND.BREAKOUT_MIN;
    
    if (!isBreakout) {
      return { isTrendStart: false, details: { reason: 'NO_BREAKOUT', change: candleChangePct.toFixed(2) } };
    }

    // 3. TREND TEYİT (Son N mum aynı yönde mi?)
    // Config'den alınan değer: TREND.TREND_CONFIRM_CANDLES
    const last2Candles = candles.slice(-(SYSTEM_CONFIG.TREND.TREND_CONFIRM_CANDLES + 1));
    const isBullish = candleChangePct > 0;
    const trendConfirmed = isBullish 
      ? last2Candles.every(c => c.close >= c.open * 0.999) // Küçük tolerans
      : last2Candles.every(c => c.close <= c.open * 1.001);
    
    // Trend teyit zorunlu değil, sadece bonus
    // if (!trendConfirmed) { ... } - KALDIRILDI

    // 4. HACİM KONTROLÜ (opsiyonel, bonus puan)
    const pumpCheck = checkPumpStart(symbol, currentPrice, 0, candleChangePct);
    const hasVolumeSpike = pumpCheck.volumeRatio >= 1.3;

    // 5. CONTEXT (SMA kontrolü - opsiyonel)
    let contextOK = true;
    if (candles.length >= 15) {
      const sma7 = candles.slice(-7).reduce((sum, c) => sum + c.close, 0) / 7;
      const sma15 = candles.slice(-15).reduce((sum, c) => sum + c.close, 0) / 15;
      
      if (isBullish && sma7 < sma15 * 0.97) contextOK = false;
      if (!isBullish && sma7 > sma15 * 1.03) contextOK = false;
    }

    // Final karar - daha gevşek
    const isTrendStart = isBreakout && (trendConfirmed || hasVolumeSpike || contextOK);

    return { 
      isTrendStart, 
      details: {
        consolidationRange: rangePercent.toFixed(2),
        breakoutPercent: candleChangePct.toFixed(2),
        volumeRatio: pumpCheck.volumeRatio.toFixed(2),
        trendConfirmed,
        hasVolumeSpike,
        context: isBullish ? 'BULLISH' : 'BEARISH',
        contextOK
      }
    };
  }, [checkPumpStart]);

  // QUICK MOMENTUM CHECK (Hızlı sinyal için)
  const checkQuickMomentum = useCallback((
    symbol: string,
    price: number,
    candleChangePct: number,
    volume: number
  ): { isSignal: boolean; type: string; strength: number } => {
    const hist = rollingHistoryRef.current[symbol];
    if (!hist || hist.prices.length < 5) {
      return { isSignal: false, type: '', strength: 0 };
    }

    const recentPrices = hist.prices.slice(-5);
    const avgVolume = hist.volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (hist.volumes.length - 1);
    const volumeRatio = volume / avgVolume;

    // Fiyat momentum
    const priceChange5 = ((price - recentPrices[0]) / recentPrices[0]) * 100;
    const isRising = recentPrices.every((p, i) => i === 0 || p >= recentPrices[i-1] * 0.998);
    const isFalling = recentPrices.every((p, i) => i === 0 || p <= recentPrices[i-1] * 1.002);

    let type = '';
    let strength = 0;
    let isSignal = false;

    // PARABOLIC: Yüksek hacim spike (Config'den alınan değerler)
    if (volumeRatio > SYSTEM_CONFIG.MOMENTUM.PARABOLIC_VOLUME_RATIO && Math.abs(candleChangePct) >= SYSTEM_CONFIG.MOMENTUM.PARABOLIC_PRICE_CHANGE) {
      type = 'PARABOLIC';
      strength = Math.min(100, volumeRatio * 30);
      isSignal = true;
    }
    // STAIRCASE: Düzenli yükseliş/düşüş (Config'den alınan değer)
    else if ((isRising || isFalling) && volumeRatio > SYSTEM_CONFIG.MOMENTUM.STAIRCASE_VOLUME_RATIO) {
      type = 'STAIRCASE';
      strength = Math.min(100, Math.abs(priceChange5) * 20 + volumeRatio * 10);
      isSignal = true;
    }
    // INSTITUTIONAL: Orta hacim, belirgin hareket (Config'den alınan değerler)
    else if (volumeRatio > SYSTEM_CONFIG.MOMENTUM.INSTITUTIONAL_VOLUME_RATIO && Math.abs(candleChangePct) >= SYSTEM_CONFIG.MOMENTUM.INSTITUTIONAL_PRICE_CHANGE) {
      type = 'INSTITUTIONAL';
      strength = Math.min(100, volumeRatio * 25 + Math.abs(candleChangePct) * 15);
      isSignal = true;
    }
    // MOMENTUM: Temel sinyal (Config'den alınan değerler)
    else if (Math.abs(candleChangePct) >= SYSTEM_CONFIG.MOMENTUM.BASIC_PRICE_CHANGE && volumeRatio > SYSTEM_CONFIG.MOMENTUM.BASIC_VOLUME_RATIO) {
      type = 'MOMENTUM';
      strength = Math.min(100, Math.abs(candleChangePct) * 30 + volumeRatio * 15);
      isSignal = true;
    }

    return { isSignal, type, strength };
  }, []);

  // Ana WebSocket bağlantısı
  useEffect(() => {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (!Array.isArray(data)) return;

      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const nextMarketData: Record<string, SymbolData> = {};
      const newAlertsFound: TradingAlert[] = [];
      const updatedTrends: Record<string, 'up' | 'down' | null> = {};

      data.forEach((item: any) => {
        const symbol = item.s;
        if (!symbol.endsWith('USDT')) return;
        
        const price = parseFloat(item.c);
        const currentQuoteVolume = parseFloat(item.q);
        const lastQuoteVolume = lastQuoteVolumeRef.current[symbol] || currentQuoteVolume;
        const tickVolume = Math.max(0, currentQuoteVolume - lastQuoteVolume);
        lastQuoteVolumeRef.current[symbol] = currentQuoteVolume;

        nextMarketData[symbol] = { symbol, price, change24h: parseFloat(item.P), volume: currentQuoteVolume };

        if (!rollingHistoryRef.current[symbol]) rollingHistoryRef.current[symbol] = { prices: [], volumes: [] };
        const hist = rollingHistoryRef.current[symbol];
        hist.prices.push(price);
        hist.volumes.push(currentQuoteVolume);
        if (hist.prices.length > 30) { hist.prices.shift(); hist.volumes.shift(); }

        const lastCandleInfo = candleOpenPricesRef.current[symbol];
        if (!lastCandleInfo || lastCandleInfo.minute !== currentMinute) {
          if (lastCandleInfo) {
            if (!candleHistoryRef.current[symbol]) candleHistoryRef.current[symbol] = [];
            const prevCandles = candleHistoryRef.current[symbol];
            const lastPrice = prevCandles.length > 0 ? prevCandles[prevCandles.length - 1].close : lastCandleInfo.price;
            candleHistoryRef.current[symbol].push({
              open: lastCandleInfo.price,
              close: price,
              high: Math.max(lastCandleInfo.price, price),
              low: Math.min(lastCandleInfo.price, price),
              volume: tickVolume,
              minute: lastCandleInfo.minute
            });
            if (candleHistoryRef.current[symbol].length > 60) candleHistoryRef.current[symbol].shift();
          }
          candleOpenPricesRef.current[symbol] = { price, minute: currentMinute };
        }

        const openPrice = candleOpenPricesRef.current[symbol].price;
        const candleChangePct = ((price - openPrice) / openPrice) * 100;
        const absChange = Math.abs(candleChangePct);

        if (isBlacklisted(symbol)) return;

        let alertCreated = false;

        // 1. PUMP TESPİTİ
        if (config.pumpDetectionEnabled) {
          const pumpCheck = checkPumpStart(symbol, price, tickVolume, candleChangePct);
          if (pumpCheck.isPump) {
            const pumpAlert: TradingAlert = {
              id: `pump-${symbol}-${now}`,
              symbol,
              side: candleChangePct > 0 ? 'LONG' : 'SHORT',
              reason: '🔥 PUMP DETECTED',
              change: candleChangePct,
              price,
              previousPrice: openPrice,
              timestamp: now,
              executed: false,
              isElite: true, 
              eliteType: 'PUMP_START',
              volumeMultiplier: pumpCheck.volumeRatio,
              autoTrade: false // Manuel onay gerekli
            };
            newAlertsFound.push(pumpAlert);
            alertCreated = true;
            
            // Hybrid: Pump tespit edilince detaylı veri çek
            fetchCandidateData(symbol);
            
            lastAlertDataRef.current[symbol] = { time: now, change: absChange };
            updatedTrends[symbol] = candleChangePct > 0 ? 'up' : 'down';
            if (trendTimeoutsRef.current[symbol]) clearTimeout(trendTimeoutsRef.current[symbol]);
            trendTimeoutsRef.current[symbol] = setTimeout(() => setTempTrends(p => ({...p, [symbol]: null})), 5000);
          }
        }

        // 2. TREND START TESPİTİ
        if (!alertCreated) {
          const trendCheck = checkTrendStart(symbol, price, candleChangePct);
          if (trendCheck.isTrendStart) {
            // Aynı coin için TREND_START cooldown'ı kontrol et (config'den alınan değer: 60 saniye)
            const lastTrendAlert = lastAlertDataRef.current[symbol];
            const trendCooldownPassed = !lastTrendAlert || (now - lastTrendAlert.time > SYSTEM_CONFIG.ALERTS.TREND_COOLDOWN_MS);
            
            if (trendCooldownPassed) {
              const trendAlert: TradingAlert = {
                id: `trend-${symbol}-${now}`,
                symbol,
                side: candleChangePct > 0 ? 'LONG' : 'SHORT',
                reason: '🚀 TREND START',
                change: candleChangePct,
                price,
                previousPrice: openPrice,
                timestamp: now,
                executed: false,
                isElite: true,
                eliteType: 'TREND_START',
                volumeMultiplier: parseFloat(trendCheck.details.volumeRatio),
                autoTrade: true,
                trendDetails: trendCheck.details
              };
              newAlertsFound.push(trendAlert);
              alertCreated = true;
              
              lastAlertDataRef.current[symbol] = { time: now, change: absChange };
              updatedTrends[symbol] = candleChangePct > 0 ? 'up' : 'down';
              if (trendTimeoutsRef.current[symbol]) clearTimeout(trendTimeoutsRef.current[symbol]);
              trendTimeoutsRef.current[symbol] = setTimeout(() => setTempTrends(p => ({...p, [symbol]: null})), 5000);
            }
          }
        }

        // 3. QUICK MOMENTUM (Elite Alert yerine)
        if (!alertCreated && absChange >= config.priceChangeThreshold) {
          const lastAlert = lastAlertDataRef.current[symbol];
          const cooldownPassed = !lastAlert || (now - lastAlert.time > 8000); // 8 saniye cooldown
          
          if (cooldownPassed) {
            const momentum = checkQuickMomentum(symbol, price, candleChangePct, currentQuoteVolume);
            
            if (momentum.isSignal) {
              const newAlert: TradingAlert = { 
                id: `${symbol}-${now}`, 
                symbol, 
                side: candleChangePct > 0 ? 'LONG' : 'SHORT',
                reason: momentum.type === 'MOMENTUM' ? 'PULSE MOMENTUM' : `ELITE ${momentum.type}`,
                change: candleChangePct, 
                price, 
                previousPrice: openPrice, 
                timestamp: now, 
                executed: false,
                isElite: momentum.type !== 'MOMENTUM',
                eliteType: momentum.type !== 'MOMENTUM' ? momentum.type as any : undefined, 
                volumeMultiplier: currentQuoteVolume / (hist.volumes.slice(0,-1).reduce((a,b)=>a+b,0)/(hist.volumes.length-1)),
                autoTrade: true
              };
              newAlertsFound.push(newAlert);
              alertCreated = true;
              
              lastAlertDataRef.current[symbol] = { time: now, change: absChange };
              updatedTrends[symbol] = candleChangePct > 0 ? 'up' : 'down';
              if (trendTimeoutsRef.current[symbol]) clearTimeout(trendTimeoutsRef.current[symbol]);
              trendTimeoutsRef.current[symbol] = setTimeout(() => setTempTrends(p => ({...p, [symbol]: null})), 5000);
            }
          }
        }
      });
      
      setMarketData(prev => ({ ...prev, ...nextMarketData }));
      if (Object.keys(updatedTrends).length > 0) setTempTrends(p => ({...p, ...updatedTrends}));
      if (newAlertsFound.length > 0) setAlerts(prev => [...newAlertsFound, ...prev].slice(0, MAX_ALERTS));
    };
    
    return () => ws.close();
  }, [isBlacklisted, config.eliteMode, config.priceChangeThreshold, config.pumpDetectionEnabled, checkPumpStart, checkTrendStart, checkQuickMomentum, fetchCandidateData]);

  const closeTrade = useCallback((pos: Position, currentPrice: number, reason: string) => {
    const isLong = pos.side === 'LONG';
    const priceDiff = isLong ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
    const pnlAtExit = priceDiff * pos.quantity;
    const closingFee = (pos.quantity * currentPrice) * FEE_RATE;
    const finalPnl = pnlAtExit - closingFee;
    
    const historyItem: TradeHistoryItem = {
      id: pos.id, symbol: pos.symbol, side: pos.side, leverage: pos.leverage, quantity: pos.quantity,
      entryPrice: pos.entryPrice, exitPrice: currentPrice, stopLoss: pos.stopLoss, tp1: pos.tp1, tp2: pos.tp2,
      pnl: finalPnl, pnlPercent: (finalPnl / pos.margin) * 100, maxPnlPercent: pos.maxPnlPercent,
      timestamp: pos.timestamp, closedAt: Date.now(), duration: Date.now() - pos.timestamp,
      balanceAfter: account.balance + (pos.margin * (pos.quantity / pos.initialQuantity)) + finalPnl, reason, efficiency: finalPnl > 0 ? 'PERFECT' : 'LOSS', details: reason,
      totalFees: pos.fees + closingFee, minPriceDuringTrade: pos.minPrice, maxPriceDuringTrade: pos.maxPrice,
      initialMargin: pos.margin, source: pos.source
    };
    return { netBalanceChange: (pos.margin * (pos.quantity / pos.initialQuantity)) + finalPnl, historyItem };
  }, [account.balance]);

  useEffect(() => {
    if (positions.length === 0) return;
    const interval = setInterval(() => {
      let needsStateUpdate = false;
      let balanceAdjustment = 0;
      let newHistory: TradeHistoryItem[] = [];
      
      const nextPositions = positions.map(pos => {
        const market = marketData[pos.symbol];
        if (!market) return pos;
        const currentPrice = market.price;
        const isLong = pos.side === 'LONG';
        
        const slHit = isLong ? currentPrice <= pos.stopLoss : currentPrice >= pos.stopLoss;
        if (slHit) {
          const reason = pos.trailingStopActive ? 'TRAILING SL EXIT' : (pos.tp1Hit ? 'SL (BE) EXIT' : 'SL EXIT');
          const { netBalanceChange, historyItem } = closeTrade(pos, currentPrice, reason);
          balanceAdjustment += netBalanceChange; newHistory.push(historyItem); needsStateUpdate = true; return null;
        }

        const tp1Reached = isLong ? currentPrice >= pos.tp1 : currentPrice <= pos.tp1;
        if (tp1Reached && !pos.tp1Hit) {
          const closeQuantity = pos.initialQuantity * 0.40;
          const keepQuantity = pos.quantity - closeQuantity;
          const priceDiff = isLong ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
          const netPnl = (priceDiff * closeQuantity) - ((closeQuantity * currentPrice) * FEE_RATE);
          
          balanceAdjustment += netPnl;
          newHistory.push({
            ...pos, id: `${pos.id}-tp1`, quantity: closeQuantity, exitPrice: currentPrice,
            pnl: netPnl, pnlPercent: (netPnl / (pos.margin * 0.4)) * 100, closedAt: Date.now(),
            reason: 'TP1 PARTIAL (40%)', balanceAfter: account.balance + balanceAdjustment, efficiency: 'PARTIAL',
            details: `TP1 Reached. 40% Closed. SL moved to Entry.`
          } as any);

          needsStateUpdate = true;
          return { ...pos, tp1Hit: true, quantity: keepQuantity, stopLoss: pos.entryPrice, partialCloses: { ...pos.partialCloses, tp1: closeQuantity } };
        }

        const tp2Reached = isLong ? currentPrice >= pos.tp2 : currentPrice <= pos.tp2;
        if (tp2Reached && pos.tp1Hit && !pos.tp2Hit) {
          const closeQuantity = pos.quantity * 0.50;
          const keepQuantity = pos.quantity - closeQuantity;
          const priceDiff = isLong ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
          const netPnl = (priceDiff * closeQuantity) - ((closeQuantity * currentPrice) * FEE_RATE);

          balanceAdjustment += netPnl;
          newHistory.push({
            ...pos, id: `${pos.id}-tp2`, quantity: closeQuantity, exitPrice: currentPrice,
            pnl: netPnl, pnlPercent: (netPnl / (pos.margin * 0.3)) * 100, closedAt: Date.now(),
            reason: 'TP2 PARTIAL (30%)', balanceAfter: account.balance + balanceAdjustment, efficiency: 'PARTIAL',
            details: `TP2 Reached. 30% Closed. Trailing SL Active.`
          } as any);

          needsStateUpdate = true;
          return { ...pos, tp2Hit: true, trailingStopActive: true, quantity: keepQuantity, stopLoss: pos.tp1, partialCloses: { ...pos.partialCloses, tp2: closeQuantity } };
        }

        let updatedPos = { ...pos };
        if (pos.trailingStopActive) {
          const newMax = Math.max(pos.maxPrice, currentPrice);
          const newMin = Math.min(pos.minPrice, currentPrice);
          let newTrailingSL = pos.stopLoss;
          if (isLong) {
            const calcSL = newMax * 0.985;
            if (calcSL > pos.stopLoss) newTrailingSL = calcSL;
          } else {
            const calcSL = newMin * 1.015;
            if (calcSL < pos.stopLoss) newTrailingSL = calcSL;
          }
          if (newTrailingSL !== pos.stopLoss || newMax !== pos.maxPrice || newMin !== pos.minPrice) {
            updatedPos = { ...updatedPos, stopLoss: newTrailingSL, maxPrice: newMax, minPrice: newMin };
            needsStateUpdate = true;
          }
        } else {
          const nextMax = Math.max(pos.maxPrice, currentPrice);
          const nextMin = Math.min(pos.minPrice, currentPrice);
          if (nextMax !== pos.maxPrice || nextMin !== pos.minPrice) {
            updatedPos = { ...updatedPos, maxPrice: nextMax, minPrice: nextMin };
            needsStateUpdate = true;
          }
        }
        return updatedPos;
      }).filter(p => p !== null) as Position[];

      if (needsStateUpdate) {
        if (balanceAdjustment !== 0) setAccount(prev => ({ ...prev, balance: prev.balance + balanceAdjustment }));
        if (newHistory.length > 0) setTradeHistory(prev => [...newHistory, ...prev].slice(0, MAX_HISTORY));
        setPositions(nextPositions);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [positions, marketData, closeTrade, account.balance]);

  useEffect(() => {
    if (!config.autoTrading || alerts.length === 0) return;
    const unProcessedAlerts = alerts.filter(a => !processedAlertIds.current.has(a.id));
    if (unProcessedAlerts.length === 0) return;
    let tempBalance = account.balance;
    let tempPositions = [...positions];
    let addedAny = false;
    for (const alert of unProcessedAlerts) {
      if (tempPositions.length >= config.maxConcurrentTrades) break;
      if (tempPositions.some(p => p.symbol === alert.symbol)) { processedAlertIds.current.add(alert.id); continue; }
      
      const isDirectionEnabled = alert.side === 'LONG' ? config.longEnabled : config.shortEnabled;
      const isEliteCheckPassed = config.eliteMode ? alert.isElite : true;
      const isAutoTradeAlert = alert.autoTrade !== false;

      if (isDirectionEnabled && isEliteCheckPassed && isAutoTradeAlert) {
        processedAlertIds.current.add(alert.id);
        const riskUSD = tempBalance * (config.riskPerTrade / 100);
        const slDist = alert.price * (config.stopLossPercent / 100);
        const quantity = riskUSD / slDist;
        const margin = (quantity * alert.price) / config.leverage;
        const fee = (quantity * alert.price) * FEE_RATE;
        if (margin + fee <= tempBalance) {
          const newPos: Position = {
            id: alert.id, symbol: alert.symbol, side: alert.side, entryPrice: alert.price,
            quantity, leverage: config.leverage, margin, fees: fee,
            stopLoss: alert.side === 'LONG' ? alert.price - slDist : alert.price + slDist,
            tp1: alert.side === 'LONG' ? alert.price * (1 + config.tp1Percent / 100) : alert.price * (1 - config.tp1Percent / 100),
            tp2: alert.side === 'LONG' ? alert.price * (1 + config.tp2Percent / 100) : alert.price * (1 - config.tp2Percent / 100),
            tp1Hit: false, tp2Hit: false, trailingStopActive: false, initialQuantity: quantity, partialCloses: { tp1: 0, tp2: 0 },
            pnl: 0, pnlPercent: 0, maxPnlPercent: 0, timestamp: Date.now(),
            minPrice: alert.price, maxPrice: alert.price, source: 'AUTO'
          };
          tempPositions.push(newPos); tempBalance -= (margin + fee); addedAny = true;
        }
      }
    }
    if (addedAny) { setAccount(prev => ({ ...prev, balance: tempBalance })); setPositions(tempPositions); }
  }, [alerts, config, positions, account.balance]);

  const handleManualClose = useCallback((id: string) => {
    const pos = positions.find(p => p.id === id);
    if (!pos) return;
    const price = marketData[pos.symbol]?.price || pos.entryPrice;
    const { netBalanceChange, historyItem } = closeTrade(pos, price, 'MANUAL EXIT');
    setPositions(prev => prev.filter(p => p.id !== id));
    setAccount(prev => ({ ...prev, balance: prev.balance + netBalanceChange }));
    setTradeHistory(prev => [historyItem, ...prev].slice(0, MAX_HISTORY));
  }, [positions, marketData, closeTrade]);

  const emergencyStop = useCallback(() => {
    let totalBalanceChange = 0;
    const history: TradeHistoryItem[] = [];
    positions.forEach(pos => {
      const price = marketData[pos.symbol]?.price || pos.entryPrice;
      const { netBalanceChange, historyItem } = closeTrade(pos, price, 'EMERGENCY EXIT');
      totalBalanceChange += netBalanceChange; history.push(historyItem);
    });
    setPositions([]);
    setAccount(prev => ({ ...prev, balance: prev.balance + totalBalanceChange }));
    setTradeHistory(prev => [...history, ...prev].slice(0, MAX_HISTORY));
  }, [positions, marketData, closeTrade]);

  const openManualTrade = useCallback((params: any) => {
    let symbol = (params.symbol || '').toUpperCase().trim();
    if (!symbol) symbol = selectedSymbol;
    if (symbol && !symbol.endsWith('USDT')) symbol += 'USDT';
    const market = marketData[symbol];
    if (!market) return;
    const entryPrice = market.price;
    const riskValue = params.riskValue || config.riskPerTrade;
    const leverage = params.leverage || config.leverage;
    const slPct = params.sl || config.stopLossPercent;
    const slDist = entryPrice * (slPct / 100);
    const riskUSD = account.balance * (riskValue / 100);
    const quantity = riskUSD / slDist;
    const margin = (quantity * entryPrice) / leverage;
    const fee = (quantity * entryPrice) * FEE_RATE;
    if (margin + fee > account.balance) return;
    const newPos: Position = {
      id: `man-${Date.now()}`, symbol, side: params.side, entryPrice, quantity, leverage, margin, fees: fee,
      stopLoss: params.side === 'LONG' ? entryPrice - slDist : entryPrice + slDist,
      tp1: params.side === 'LONG' ? entryPrice * (1 + params.tp1 / 100) : entryPrice * (1 - params.tp1 / 100),
      tp2: params.side === 'LONG' ? entryPrice * (1 + params.tp2 / 100) : entryPrice * (1 - params.tp2 / 100),
      tp1Hit: false, tp2Hit: false, trailingStopActive: false, initialQuantity: quantity, partialCloses: { tp1: 0, tp2: 0 },
      pnl: 0, pnlPercent: 0, maxPnlPercent: 0, timestamp: Date.now(), minPrice: entryPrice, maxPrice: entryPrice, source: 'MANUAL'
    };
    setPositions(prev => [...prev, newPos]); setAccount(prev => ({ ...prev, balance: prev.balance - margin - fee })); setSelectedSymbol(symbol); 
  }, [marketData, account.balance, selectedSymbol, config]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    if (isResizing.current === 'left') setLeftWidth(Math.max(200, Math.min(400, e.clientX)));
    else if (isResizing.current === 'right1') setRightWidth1(Math.max(250, Math.min(500, window.innerWidth - e.clientX - rightWidth2)));
    else if (isResizing.current === 'right2') setRightWidth2(Math.max(250, Math.min(500, window.innerWidth - e.clientX)));
    else if (isResizing.current === 'bottom') setBottomHeight(Math.max(150, Math.min(window.innerHeight - 200, window.innerHeight - e.clientY)));
  }, [rightWidth2]);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', () => { isResizing.current = null; document.body.style.cursor = 'default'; });
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [handleMouseMove]);

  return (
    <div className="flex flex-col h-screen w-full bg-[#0b0e11] text-[#eaecef] overflow-hidden font-sans">
      <div className="flex-1 flex overflow-hidden">
        <div className={`shrink-0 relative border-r border-[#2b3139] ${mobileTab === 'market' ? 'flex flex-1' : 'hidden lg:flex'}`} style={window.innerWidth >= 1024 ? { width: `${leftWidth}px` } : {}}>
          <MarketOverview data={marketData} selected={selectedSymbol} onSelect={(s) => { setSelectedSymbol(s); if(window.innerWidth < 1024) setMobileTab('chart'); }} trends={tempTrends} />
          <div className="hidden lg:block absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#fcd535]/50 z-50 transition-colors" onMouseDown={() => { isResizing.current = 'left'; document.body.style.cursor = 'col-resize'; }}></div>
        </div>
        <div className={`flex-1 min-0 flex-col ${mobileTab === 'chart' || mobileTab === 'positions' ? 'flex' : 'hidden lg:flex'}`}>
          <div className={`flex-1 relative bg-black border-b border-[#2b3139] ${mobileTab === 'positions' ? 'hidden lg:block' : 'block'}`}>
            <TradingChart key={selectedSymbol} symbol={selectedSymbol} />
          </div>
          <div className="hidden lg:block h-1 cursor-row-resize hover:bg-[#fcd535]/50 z-50 transition-colors bg-[#2b3139]/30" onMouseDown={() => { isResizing.current = 'bottom'; document.body.style.cursor = 'row-resize'; }}></div>
          <div className={`overflow-hidden shrink-0 ${mobileTab === 'chart' ? 'hidden lg:block' : 'block flex-1'}`} style={window.innerWidth >= 1024 ? { height: `${bottomHeight}px` } : {}}>
            <PositionsPanel positions={positions} history={tradeHistory} onManualClose={handleManualClose} marketData={marketData} onSelectSymbol={(s) => { setSelectedSymbol(s); if(window.innerWidth < 1024) setMobileTab('chart'); }} />
          </div>
        </div>
        <div className={`bg-[#0b0e11] border-l border-[#2b3139] flex-col shrink-0 relative ${mobileTab === 'alerts' ? 'flex flex-1' : 'hidden lg:flex'}`} style={window.innerWidth >= 1024 ? { width: `${rightWidth1}px` } : {}}>
          <div className="hidden lg:block absolute left-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#fcd535]/50 z-50 transition-colors" onMouseDown={() => { isResizing.current = 'right1'; document.body.style.cursor = 'col-resize'; }}></div>
          <AlertsPanel 
            alerts={alerts} 
            onSelect={(s) => { setSelectedSymbol(s); if(window.innerWidth < 1024) setMobileTab('chart'); }} 
            activePositions={positions} 
            marketData={marketData} 
            eliteMode={config.eliteMode}
            onQuickTrade={(a) => openManualTrade({ symbol: a.symbol, side: a.side, leverage: config.leverage, riskValue: config.riskPerTrade, sl: config.stopLossPercent, tp1: config.tp1Percent, tp2: config.tp2Percent })} 
          />
        </div>
        <div className={`shrink-0 border-l border-[#2b3139] p-4 bg-[#0b0e11] overflow-y-auto custom-scrollbar relative ${mobileTab === 'controls' ? 'block flex-1' : 'hidden lg:block'}`} style={window.innerWidth >= 1024 ? { width: `${rightWidth2}px` } : {}}>
          <div className="hidden lg:block absolute left-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#fcd535]/50 z-50 transition-colors" onMouseDown={() => { isResizing.current = 'right2'; document.body.style.cursor = 'col-resize'; }}></div>
          <TradingControls config={config} setConfig={setConfig} account={account} marketData={marketData} positions={positions} emergencyStop={emergencyStop} onManualTrade={openManualTrade} />
        </div>
      </div>
      <div className="lg:hidden h-16 bg-[#1e2329] border-t border-[#2b3139] flex items-center justify-around px-2 shrink-0 shadow-[0_-5px_15px_rgba(0,0,0,0.5)] z-[100]">
        {[
          { id: 'market', label: 'Market', icon: '📊' },
          { id: 'alerts', label: 'Alerts', icon: '🔔' },
          { id: 'chart', label: 'Chart', icon: '📈' },
          { id: 'positions', label: 'Trade', icon: '💼' },
          { id: 'controls', label: 'Bot', icon: '⚙️' }
        ].map((t) => (
          <button key={t.id} onClick={() => setMobileTab(t.id as MobileTab)} className={`flex flex-col items-center justify-center gap-1 transition-all ${mobileTab === t.id ? 'text-[#fcd535] scale-110' : 'text-[#848e9c]'}`}>
            <span className="text-xl">{t.icon}</span>
            <span className="text-[9px] font-black uppercase tracking-tighter">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default App;