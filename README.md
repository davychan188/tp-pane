# tp-pane

離線 GeoPackage（`.gpkg`）／Excel 樹木清單檢視器，專為園藝／樹木調查工作流而設：**地圖（或地圖 PDF）＋屬性＋直放相片＋PDF 頁碼**。  
改編自上游 [hugoleung04/gpkg-viewer](https://github.com/hugoleung04/gpkg-viewer)（本機無寫入上游權限；此資料夾為獨立 fork）。

- 檔案只在瀏覽器本機讀取，不上傳
- 適合 **iPad mini 橫向**：左半地圖／屬性，右半媒體
- 相片按樹木編號配對（例如 `T1` → `T1_*.jpg`）
- **無需 GPKG** 亦可：匯入 Excel 清單＋地圖 PDF＋媒體資料夾，或 **從零加樹**（點地圖標註）
- **自動儲存**：樹木清單與標記（含 ID／x／y／DBH／H／S 等）寫入 `localStorage`，重新整理／離線 PWA 可還原；地圖檔需再匯入
- **隱藏相片**：頂部「隱藏相片／顯示相片」收合右側媒體欄，方便野外只看地圖與屬性（偏好會記住）
- 樹木清單可 **內嵌編輯** ID／DBH／H／S／樹種（雙擊或 Pencil 雙點）
- 示範模式仍可一鍵試 UI

## 系統需求

- 現代瀏覽器（Safari / Chrome / Edge / Firefox）
- Python 3（只用作本機 HTTP；WASM 無法從 `file://` 穩定載入）

## 如何啟動

### Windows

雙擊 `start.bat`，或：

```bat
python start.py
```

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

瀏覽器會開啟 `http://127.0.0.1:8765/`。使用期間請保持終端機視窗開啟；`Ctrl+C` 結束。

### 示範（無需自備檔案）

```
http://127.0.0.1:8765/?demo=1
```

會載入示範樹木 **T1 / T2 / T8 / T30** 與內建示範相片／PDF。  
亦可在畫面上按 **「示範樹木」**、**「示範媒體」**。

若要改載上游河流樣本 GPKG：`?demo=1&trees=0`

## 無需 GPKG 的新工作流程

適合只有 Excel 樹木清單＋現場地圖 PDF＋相片資料夾的情況：

1. **匯入 Excel**（`.xlsx` / `.xls` / `.csv`）  
   - 樹木編號欄寬鬆辨識：`Tree ID`、`Tree No.`、`No.`、`Tag`、`Label`、`TREE`、`Plant No`、`樹號`、`木號`、`號碼`、`編號`、`ID` 等  
   - CSV 會去掉 BOM；若仍對不到欄名，會依內容（如 `T1`／`T30`）自動用第一欄，並在狀態列說明用了哪一欄  
   - 失敗時錯誤會列出實際欄名：`找不到樹木編號欄。現有欄名：…`  
   - 選填：Species／樹種、DBH／胸徑、Height／高度、Spread／冠幅、Defect／缺陷、Location／位置  
   - 若有座標（`Latitude`/`Longitude` 或 `X`/`Y`／Easting／Northing）會在地圖上顯示標記  
   - **無座標**時左側會出現可捲動的 **樹木清單**，點選即可看屬性與媒體
2. **匯入地圖 PDF**（或 JPG／PNG）  
   - 匯入後會**立即**蓋住左側地圖區（`force-map-ref`）；無 GPKG／無座標標記時亦會持續顯示  
   - 以 `<object>`／`<embed>` 顯示 PDF（Safari 對 `blob:` iframe 較不穩），並提供 **「新分頁開啟地圖 PDF」**  
   - 若同時有地圖標記，可用工具列 **「切換地圖」** 在 Leaflet 與 PDF／圖片之間切換
3. **媒體資料夾**（與以往相同）  
   - 相片檔名：`T1_*.jpg` 等  
   - PDF 調查報告會顯示頁碼掣
4. 選樹（清單或地圖標記）→ 顯示屬性＋相片＋PDF 頁面 UI

樣本檔：

| 檔案 | 說明 |
|---|---|
| `samples/demo_trees.csv` | 含部分座標的示範清單 |
| `samples/demo_trees_list_only.csv` | 僅清單（中文欄名、無座標） |
| `samples/demo_trees_alt_headers.csv` | `Plant No` 等寬鬆欄名樣本 |
| `samples/media/` | 示範相片與調查 PDF |
| `templates/Tree Inventory Template.xlsx` | 目錄匯出範本（上游） |


### 樹木資料面板（可編輯）

- 選樹後左下 **樹木資料** 顯示屬性；**雙擊**（或快速雙點）數值可內嵌編輯，Enter／失焦儲存、Esc 取消  
- 儲存會寫回記憶體中的樹木屬性（Excel 匯入／標註／示範／GPKG 選取），目錄表與之後匯出會反映變更  
- 版面第二列為三格：**DBH**（胸徑）、**H**（高度）、**S**（冠幅）；缺欄時仍顯示空白可編輯  
- Species／Defect／Location 等其餘欄位同樣可雙擊編輯  

### 從零加樹（地圖點擊標註 · Annotate）

適合幾乎沒有原始清單／座標時：先匯入地圖圖片，再開「加樹模式」在圖上點出樹木。

1. **匯入地圖**（建議 **PNG／JPG**；PDF 可顯示但點擊較不準，會用透明層相對檢視框記錄位置）
2. 開啟 **加樹模式 Add tree**（左側欄；地圖 PDF 時用地圖工具列；Leaflet 加樹開啟後於地圖左下有精簡列）
3. 選擇編號方式：
   - **自動編號 Auto**：點一下地圖 → `T1`、`T2`、`T3`…（略過已有編號）
   - **手動編號 Manual**：點一下後跳出輸入框，輸入自訂 ID 再放置
4. 左側 **樹木清單** 顯示每棵樹的 **x／y（相對檢視框 %）**；可點選、可 ✕ 刪除；無需相片亦可  
   - 雙擊（或 Apple Pencil 快速雙點）**Tree ID／Species／DBH／H／S** 可直接改值，與左下「樹木資料」同步，並自動儲存
5. **匯出列表 Export CSV**：下載含 `Species,DBH,Height,Spread,Defect,Location` 與座標欄
6. 之後仍可再匯入媒體資料夾，依檔名前綴配對相片
7. 重新整理後會還原樹木清單與標記；若曾匯入地圖，會提示重新選擇同一地圖檔（blob 無法可靠持久化）

技術備註：

- `#map-annotate-layer` 透明層覆蓋 `#map-ref-viewer`，座標以 overlay 百分比（0–100）儲存
- Leaflet 可見時亦可點地圖加樹（同時記錄 lat／lng 與容器 %）
- 不需 GPKG、不需 Excel、不需相片即可使用；既有 Excel／媒體／GPKG／示範流程不受影響

### Excel 解析說明

- 瀏覽器內使用 **SheetJS（xlsx）**：已放到 `vendor/xlsx.full.min.js`，可離線使用  
- `.csv` 亦可（`FileReader` 本機解析，不需 SheetJS；會 strip BOM）  
- 編號欄找不到時會依儲存格內容推斷，並在狀態列顯示所用欄名

## iPad mini 使用提示

1. 電腦執行 `start.py` 後，終端機會顯示區網位址（例如 `http://192.168.x.x:8765/`）。
2. iPad 與電腦同一 Wi‑Fi，用 **Safari** 開啟該位址。
3. 建議 **橫向（landscape）**：左約 50% 地圖＋樹木資料，右約 50% 相片／PDF。不需相片時可按 **隱藏相片** 讓地圖／屬性佔滿。
4. 可選：Safari 分享 → **加入主畫面**（PWA）；樹木清單會自動還原。
4b. Apple Pencil：清單列與地圖標記有較大點擊區；用點擊／雙點編輯，勿依賴 hover。
5. 開啟 `.gpkg`（可選）：先存入「檔案」App，再按 **開啟 GPKG**。
6. 或按 **匯入 Excel**、**匯入地圖 PDF**，再按 **媒體資料夾** 選相片／PDF。
7. 相片操作：左右掣或左右滑動；顯示檔名與 `2 / 4`。可用 **放大／縮小／重設**（＋／−／1×）；觸控支援捏合縮放、雙擊縮放，放大後可拖曳平移。換樹或換下一張會重設縮放。
8. PDF：號碼掣 `#07`、`#08`；上方顯示 **現在第 8 / 20 頁**。預覽區同樣有 **放大／縮小／重設**（CSS scale）；可 **新分頁開啟**。地圖參考 PDF／圖片工具列亦有相同縮放掣（並保留「新分頁開啟地圖 PDF」）。

## 傳統 GPKG 工作流程

1. （可選）按 **示範樹木**，或開啟你的 `.gpkg` / `.geojson`。
2. 點選地圖上的樹木 → 左下顯示屬性，右側顯示該樹相片。
3. 按 **媒體資料夾** 載入現場相片與調查 PDF（檔案不出裝置）。
4. 需要時可標紅、移動點位、另存、匯出目錄（沿用上游能力）。

GPKG 開啟／拖放流程維持不變，可與 Excel／地圖 PDF 並存使用（清除全部會一併清掉）。

## 相片命名（PhotoRenamer）

媒體面板用**檔名前綴**配對樹木編號：

| 樹木編號 | 建議檔名例子 |
|---|---|
| T1 | `T1_001.jpg`、`T1_defect.jpg`、`T1_crown.jpg` |
| T30 | `T30_001.jpg`、`T30_base.jpg` |

規則：

- 格式：`{TreeID}_{說明}.{jpg|png|webp…}`
- `TreeID` 與 GPKG／Excel／屬性表的編號欄一致
- 可用同伴工具 **PhotoRenamer** 批次改名後再選入本檢視器
- 一個編號可有多張相片；面板每次只顯示**一張直放**

## 資料夾結構

```
gpkg-viewer-media/
  start.py / start.bat / start.sh   本機伺服器
  index.html                        畫面（含媒體面板、匯入按鈕）
  app.js                            地圖／GPKG 引擎＋Excel 圖層載入
  media.js                          相片／PDF 面板與配對邏輯
  import-extras.js                  Excel／CSV 解析＋樹木清單＋地圖 PDF＋加樹標註
  styles.css                        含 iPad 左右分欄
  samples/                          示範 GPKG／CSV／媒體
  templates/                        目錄 Excel 範本
  vendor/                           Leaflet + GeoPackage JS + wasm + SheetJS
```

## 與上游的差異（摘要）

| 項目 | 說明 |
|---|---|
| 佈局 | 新增右側媒體欄；橫向約 50/50；可 **隱藏相片** |
| 選樹 | `selectMarker` → `GpkgMedia.setSelectedTree` |
| 無 GPKG | **匯入 Excel**、**匯入地圖 PDF**、樹木清單、**加樹模式**（自動／手動編號＋x／y） |
| 持久化 | 樹木清單／標記 autosave → `localStorage`（地圖檔需再匯入） |
| 清單編輯 | 內嵌改 ID／DBH／H／S／Species（與屬性卡同步） |
| 示範 | 無需 GPKG 的 demo trees + 內建媒體 |
| UI 文案 | 中英對照（繁體中文為主） |
| 啟動 | 仍用 Python 本機伺服器（同上游） |

## 限制

- PDF 多頁跳轉依賴瀏覽器內建 PDF 檢視（`#page=`）；部分流動瀏覽器預覽較弱
- 相片／相關 PDF／地圖參考支援 **放大／縮小／重設**（transform scale；iframe／object 原生縮放有限故採外層 scale）；工具提示：放大／縮小／重設
- 地圖參考 PDF 以 `<object>`／`<embed>`（＋ iframe 後備）顯示；Safari 可改用「新分頁開啟」（MVP，不另加 pdf.js）
- 加樹模式對 **PNG／JPG** 最準；PDF 改以透明 overlay 記錄相對 %（非 PDF 頁面座標）
- HEIC 等格式視系統／瀏覽器支援而定；建議 JPG／PNG
- 大型 GPKG 仍受上游「圖徵上限」影響（預設 25,000）
- 無寫入上游 repo；請在此資料夾自行備份／發佈

## 致謝

- 上游：[hugoleung04/gpkg-viewer](https://github.com/hugoleung04/gpkg-viewer)
- [NGA GeoPackage JS](https://github.com/ngageoint/geopackage-js)
- [Leaflet](https://leafletjs.com/)
- [SheetJS](https://sheetjs.com/)（Excel 解析，已 vendor）
