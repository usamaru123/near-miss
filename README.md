# NEAR//MISS

> スレスレで生き残れ。避けるほど速く、速いほど稼げる。

ネオンのトンネルを最高 1620 km/h で突き進む、反射神経アクションゲーム。
障害物をギリギリでかわす「ニアミス」で得点とアドレナリンを稼ぎ、OVERDRIVE で全てを粉砕しろ。

**▶ 遊ぶ: https://usamaru123.github.io/near-miss/**

## 操作

| キー | 動作 |
|---|---|
| ← → / A D | トンネル内壁を周回移動 |
| Space | OVERDRIVE（ゲージ満タン時） |
| Shift（長押し） | FOCUS（スローモー） |
| P / Esc | ポーズ |
| M | ミュート |

スマホ: 画面の左右半分をタッチで移動、2 本指タップで OVERDRIVE。

フラッシュ・画面の揺れが苦手な方はタイトル画面の「フラッシュ軽減」を ON にしてください。

## 技術

Vite + TypeScript / three.js + postprocessing / Tone.js（手続き生成 BGM・効果音）/ Vitest + Playwright

```bash
npm install
npm run dev        # 開発サーバー
npm test           # ユニットテスト
npm run test:e2e   # E2E テスト
```

設計の詳細は [DESIGN.md](DESIGN.md)、音源サンプルの出典は [public/audio/CREDITS.md](public/audio/CREDITS.md)。
