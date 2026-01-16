
import { StrategyConfig } from './types';

export const DEFAULT_CONFIG: StrategyConfig = {
  autoTrading: true,
  eliteMode: true, 
  pumpDetectionEnabled: true,
  whaleDetectionEnabled: true,   // YENİ: Whale detection aktif
  longEnabled: true,
  shortEnabled: true,
  leverage: 20,             
  riskPerTrade: 1.0,        
  priceChangeThreshold: 1.0,
  stopLossPercent: 2.0,     
  tp1Percent: 1.0,          
  tp2Percent: 3.0,          
  cooldownMinutes: 5,
  maxConcurrentTrades: 20,
  blacklist: ['FLOW','FOGO'],
  whaleMinScore: 55,         // YENİ: Minimum %55 whale score
  useDynamicStopLoss: true,  // YENİ: Dinamik SL kullan
  ringEnabled: true,         // YENİ: Whale alert ses bildirimi
};

export const COLORS = {
  bg: '#0b0e11',
  bgSecondary: '#1e2329',
  border: '#2b3139',
  text: '#eaecef',
  textSecondary: '#848e9c',
  up: '#00c076',
  down: '#f84960',
  accent: '#fcd535',
  elite: '#a855f7', 
};
