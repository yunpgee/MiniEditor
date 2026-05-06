# MiniEditor

最小限の Electron 製 Markdown エディタです。

## About

MiniEditor was created by Qingyun PIAO on 2026-05-02.

The project started from a simple wish for a lightweight editor. It was built by fully using AI assistance and a no-coding workflow: the author described the desired behavior, reviewed the results, and iterated on the application without manually writing the source code.

## 機能

- Markdown 編集とライブプレビュー
- KaTeX によるインライン数式 `$...$` とブロック数式 `$$...$$`
- ファイルの新規作成、読み込み、保存、別名保存
- プレビュー表示のオン/オフ
- プレビュー表示時の左右幅調整
- プレビュー右クリックから PDF / HTML エクスポート
- ネイティブメニューからのファイル操作
- フォントとサイズの切り替え
- Find / Replace
- Word Wrap
- Line Numbers
- Markdown / Plain 切り替え
- Time/Date 挿入
- Status Bar
- Print
- 未保存変更の表示と確認

## 起動

```sh
npm install
npm start
```

## Windows へコピーする場合

`dist`、`node_modules`、`resources/bin/tinymist` はコピー不要です。以下をコピーしてから Windows 側で `npm install` を実行してください。

```text
package.json
package-lock.json
README.md
.gitignore
src/
scripts/
resources/bin/.gitkeep
```

開発起動:

```sh
npm install
npm start
```

Windows アプリのビルド:

```sh
npm run dist:win
```

生成物を掃除する場合:

```sh
npm run clean
```

Typstプレビューを使う場合は、Windows側で `tinymist` または `typst` をインストールして `PATH` に通してください。ビルド時に `tinymist` が見つかる場合は、アプリに同梱されます。

## ファイル構成

- `src/main.js`: Electron メインプロセス、メニュー、ファイルダイアログ
- `src/preload.js`: レンダラーへ公開する安全な IPC API
- `src/index.html`: エディタ画面
- `src/renderer.js`: Markdown プレビュー、保存状態、ボタン操作
- `src/styles.css`: 最小限のレイアウトと表示
- `scripts/start-electron.js`: 開発起動用スクリプト
- `scripts/prepare-bundled-tinymist.js`: ビルド時にTinymistを同梱する準備
- `scripts/clean-generated.js`: 生成物の掃除
