# Hybrid_Binance_Whale

PHASE 1: PUMP DETECTION (Ön Filtre)
└─> %1+ fiyat artışı + 2.5x hacim patlaması
    └─> Alert oluşturulur
        
PHASE 2: ACTIVE TRACKING (Derinlemesine Analiz)
└─> API'den 60x1m, 24x5m, 16x15m klines çek
└─> 200 recent trade + 500 aggTrade analizi
└─> Order book depth analizi
└─> Support/Resistance hesaplama
└─> WebSocket stream başlat (aggTrade + bookTicker)
    
PHASE 3: WHALE/TREND ALERT GENERATION
└─> 8 farklı koşul kontrolü:
    • consolidation (konsolidasyon)
    • breakout (kırılım)
    • volumeConfirm (hacim onayı)
    • trendAlignment (trend uyumu)
    • largeOrders (büyük emirler - 5x avg)
    • imbalance (order book dengesizliği - 2.5x+)
    • supportResistance (S/R doğrulaması)
    • volatilitySpike (volatilite artışı)
