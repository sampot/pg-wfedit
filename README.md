# pg-wfedit

**流程視覺編輯**：以**垂直主軸**編輯 Playgrounds [`workflow.v1`](https://github.com/sampot/myblog/blob/main/docs/PLAYGROUNDS-WORKFLOW-DEFINITION-SPEC.md)（`workflow.yaml`）。純前端 Tool SAM；**不**執行引擎、**不**持游標。

規格：[PLAYGROUNDS-WFEDIT-SPEC](https://github.com/sampot/myblog/blob/main/docs/PLAYGROUNDS-WFEDIT-SPEC.md)（DEC-034）。

也可當作 [Playgrounds（遊樂場）](https://play.samkuo.me/) 的 **Tool SAM**：對含 `workflow.yaml` 的工作沙盒（通常是 [`pg-workflow`](https://github.com/sampot/pg-workflow)）用「用沙盒開啟」掛上，grant 建議包含 `workflow.yaml` 與 `steps/`。工具宣告在 `index.html` head（`sam:tool-kinds`／`sam:tool-globs`）。

YAML 往返可能**丟失註解**（MVP）。

圖模可**拖曳主鏈卡片**重排（落在青色插槽＝改 primary／`start`）；未命中插槽則格點微調 `ui.x`／`ui.y`。

連線編輯：拖**箭頭端點**到別張卡＝改目標；拖到空白／刪除區或按線旁 **×**＝刪除。卡底圓點可新建／改主後繼；側圓點改其他出邊。

## 一鍵開

**[一鍵開](https://play.samkuo.me/?open=sampot%2Fpg-wfedit&name=%E6%B5%81%E7%A8%8B%E8%A6%96%E8%A6%BA%E7%B7%A8%E8%BC%AF)**

```
https://play.samkuo.me/?open=sampot/pg-wfedit&name=流程視覺編輯
```

## 試玩（本機）

```bash
npx --yes serve .
```

瀏覽器開頁即可編範例（standalone）。解析 YAML 用 [js-yaml](https://github.com/nodeca/js-yaml)（esm.sh；首次需網路）。

## 測試

```bash
node --test lib/*.test.js
```

## License

MIT
