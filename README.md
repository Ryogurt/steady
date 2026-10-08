# Steady

リズムキープ練習アプリ。メトロノームや曲に合わせてタップし、拍ごとのズレを測って点数を出します。

- サイト: https://ryogurt.github.io/steady/
- `index.html` … アプリ本体（GitHub Pages で公開）
- `worker/worker.js` … 曲のBPM検索の中継（Cloudflare Workers `steady-bpm`）。APIキーは Cloudflare の秘密の変数 `GETSONGBPM_KEY` に保存
- BPMデータ提供: [GetSongBPM.com](https://getsongbpm.com)
