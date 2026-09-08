# tp-pane

離線 GeoPackage（`.gpkg`）／Excel 樹木清單檢視器，專為園藝／樹木調查工作流而設：**左上地圖｜右上樹木 PDF（pdf.js）｜底列橫向樹木列表**。  
改編自上游 [hugoleung04/gpkg-viewer](https://github.com/hugoleung04/gpkg-viewer)（本機無寫入上游權限；此資料夾為獨立 fork）。

- 檔案只在瀏覽器本機讀取，不上傳
- 適合 **iPad mini 橫向**：上排地圖｜樹木 PDF；**底列全寬樹木列表**（Excel 試算表：列＝樹、欄＝欄位；可橫向／直向捲動）
- **樹木清單／Excel 與地圖 PDF 互不依賴**：可只匯清單、只匯地圖，或兩者並用；互不阻擋
- **媒體（PDF）可獨立匯入**，唔使對應地圖／樹木清單；預設「全部媒體」。檔名前綴（例如 `T1`）僅作可選篩選「只顯示呢棵樹」
- **無需 GPKG** 亦可：匯入 Excel 清單＋地圖 PDF＋調查 PDF，或 **從零加樹**（點地圖標註）
- **自動儲存**：樹木清單與標記（含 ID／樹種／DBH／H／S／備註／x／y 等）寫入 `localStorage`，重新整理／離線 PWA 可還原；地圖檔需再匯入
- **隱藏媒體**：頂部「隱藏媒體／顯示媒體」收合右側 PDF，地圖可擴展；底列樹木列表仍保留（偏好會記住）
- 樹木清單可 **內嵌編輯** ID／樹種／DBH／H／S／備註（**點一下**欄位即可；Pencil／手指／滑鼠）
- 開發可用 `?demo=1` 深層連結載入樣本（主工具列不再顯示示範按鈕）
- 右上為 **樹木 PDF**（pdf.js canvas；**雙指 pinch 縮放／平移**，亦可用 +/- 與 Ctrl+滾輪；`devicePixelRatio × zoom` 重繪保持清晰；頁碼 chips、上／下頁）。最高約 **12×**
- **樹木列表**在底列全寬（橫向卡片，iPad 可左右滑），顯示 ID＋DBH／H／S／備註等；點一下編輯

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

### 開發用樣本（`?demo=1`）

主工具列**不再**提供「示範媒體／示範樹木」按鈕；樣本檔仍保留於 `samples/`。開發或試 UI 可用：

```
http://127.0.0.1:8765/?demo=1
```

會載入示範樹木 **T1 / T2 / T8 / T30** 與內建示範相片／PDF。  
若要改載上游河流樣本 GPKG：`?demo=1&trees=0`

## 無需 GPKG 的新工作流程

適合只有 Excel 樹木清單＋現場地圖 PDF＋相片資料夾的情況：

1. **匯入 Excel**（`.xlsx` / `.xls` / `.csv`）  
   - 樹木編號欄寬鬆辨識：`Tree ID`、`Tree No.`、`No.`、`Tag`、`Label`、`TREE`、`Plant No`、`樹號`、`木號`、`號碼`、`編號`、`ID` 等  
   - CSV 會去掉 BOM；若仍對不到欄名，會依內容（如 `T1`／`T30`）自動用第一欄，並在狀態列說明用了哪一欄  
   - 失敗時錯誤會列出實際欄名：`找不到樹木編號欄。現有欄名：…`  
   - 選填：Species／樹種、DBH／胸徑、Height／H、Spread／S、Remarks／備註、Defect／缺陷、Location／位置  
   - 若有座標（`Latitude`/`Longitude` 或 `X`/`Y`／Easting／Northing）會在地圖上顯示標記  
   - **無座標亦可**：底列出現 **Excel 式樹木列表**（試算表；可橫向／直向捲動）（不需地圖／不需地圖 PDF）；點選即可看／編輯屬性
2. **匯入地圖 PDF**（或 JPG／PNG）— **與 Excel 清單獨立**，互不阻擋  
   - 匯入後會**立即**蓋住左側地圖區（`force-map-ref`）；無 GPKG／無座標標記時亦會持續顯示  
   - 以 `<object>`／`<embed>` 顯示 PDF（Safari 對 `blob:` iframe 較不穩），並提供 **「新分頁開啟地圖 PDF」**  
   - 若同時有地圖標記，可用工具列 **「切換地圖」** 在 Leaflet 與 PDF／圖片之間切換
3. **媒體資料夾**（調查 PDF；可獨立於地圖／清單）  
   - 選 PDF 後，右側以 **pdf.js canvas** 顯示頁面（唔使先選樹，亦唔使檔名係 `T1_*`）  
   - 多個 PDF 時用頂部分頁／tabs 切換檔案；下方頁碼 chips（`#01`…）與「現在第 x / y 頁」揀頁  
   - 縮放會以高解析度重繪 canvas（非 CSS transform，避免模糊）  
   - 面板可切換「全部媒體」／「只顯示呢棵樹」（有檔名前綴時先有用）
4. 選樹（清單或地圖標記）→ 顯示屬性；媒體預設仍顯示全部（可改篩選）

樣本檔：

| 檔案 | 說明 |
|---|---|
| `samples/demo_trees.csv` | 含部分座標的示範清單 |
| `samples/demo_trees_list_only.csv` | 僅清單（中文欄名、無座標） |
| `samples/demo_trees_alt_headers.csv` | `Plant No` 等寬鬆欄名樣本 |
| `samples/media/` | 示範相片與調查 PDF |
| `templates/Tree Inventory Template.xlsx` | 目錄匯出範本（上游） |


### 樹木資料面板（可編輯）

- 選樹後左下 **樹木資料** 顯示屬性；**點一下**數值可內嵌編輯，Enter／失焦儲存、Esc 取消  
- 儲存會寫回記憶體中的樹木屬性（Excel 匯入／標註／示範／GPKG 選取），目錄表與之後匯出會反映變更  
- 版面第二列為三格：**DBH**（胸徑）、**H**（高度）、**S**（冠幅）；缺欄時仍顯示空白可編輯  
- Species／Remarks（備註）／Defect／Location 等其餘欄位同樣可點一下編輯  

### 從零加樹（地圖點擊標註 · Annotate）

適合幾乎沒有原始清單／座標時：先匯入地圖圖片，再開「加樹模式」在圖上點出樹木。

1. **匯入地圖**（建議 **PNG／JPG**；PDF 可顯示但點擊較不準，會用透明層相對檢視框記錄位置）
2. 開啟 **加樹模式 Add tree**（左側欄；地圖 PDF 時用地圖工具列；Leaflet 加樹開啟後於地圖左下有精簡列）
3. 選擇編號方式：
   - **自動編號 Auto**：點一下地圖 → `T1`、`T2`、`T3`…（略過已有編號）
   - **手動編號 Manual**：點一下後跳出輸入框，輸入自訂 ID 再放置
4. 地圖標記（加樹模式 ON）：
   - **短點／單擊**空白處 → 加樹
   - **短點**既有標記 → 選取該樹（不重複加）
   - **長按**標記約 0.45 秒後拖移 → 更新 x／y（%），鬆開自動儲存（Apple Pencil／手指）
5. 底列 **樹木列表**（橫向）顯示每棵樹的 **x／y（相對檢視框 %）**；可點選、可 ✕ 刪除；無需相片亦可  
   - **點一下** **Tree ID／Species／DBH／H／S／Remarks（備註）** 即可改值（不必雙擊），並自動儲存
6. **匯出列表 Export CSV**：下載含 `Species,DBH,Height,Spread,Remarks,Defect,Location` 與座標欄
7. 之後仍可再匯入媒體資料夾（可唔對應清單；可選檔名前綴方便篩選）
8. 重新整理後會還原樹木清單與標記；若曾匯入地圖，會提示重新選擇同一地圖檔（blob 無法可靠持久化）

技術備註：

- `#map-annotate-layer` 透明層覆蓋 `#map-ref-viewer`，座標以 overlay 百分比（0–100）儲存
- 加樹模式：短點空白處加樹；短點標記選取；長按標記（~450ms）後 `pointermove` 拖移，鬆開寫入 x／y % 並 autosave
- Leaflet 可見時亦可點地圖加樹（同時記錄 lat／lng 與容器 %）
- 不需 GPKG、不需 Excel、不需相片即可使用；既有 Excel／媒體／GPKG／示範流程不受影響

### Excel 解析說明

- 瀏覽器內使用 **SheetJS（xlsx）**：已放到 `vendor/xlsx.full.min.js`，可離線使用  
- `.csv` 亦可（`FileReader` 本機解析，不需 SheetJS；會 strip BOM）  
- 編號欄找不到時會依儲存格內容推斷，並在狀態列顯示所用欄名

## iPad mini 使用提示

1. 電腦執行 `start.py` 後，終端機會顯示區網位址（例如 `http://192.168.x.x:8765/`）。
2. iPad 與電腦同一 Wi‑Fi，用 **Safari** 開啟該位址。
3. 建議 **橫向（landscape）**：上排約 50%／50% **地圖｜樹木 PDF**，底列全寬 **樹木列表**（左右滑）。不需 PDF 時可按 **隱藏媒體** 讓地圖擴展。
4. 可選：Safari 分享 → **加入主畫面**（PWA）；樹木清單會自動還原。
4b. **Apple Pencil／pointer**：
   - 地圖（加樹模式）：**點一下**加樹；**短點標記**選取；**長按標記再拖**移動位置（鬆開儲存 x／y %）
   - 樹木清單／樹木資料：**點一下**欄位數值即可編輯（不必雙擊）
   - 點擊區偏大；勿依賴 hover
5. 開啟 `.gpkg`（可選）：先存入「檔案」App，再按 **開啟 GPKG**。
6. 或按 **匯入 Excel**、**匯入地圖 PDF**，再按 **媒體資料夾** 選相片／PDF。
7. **樹木 PDF（右上）**：pdf.js 繪製；**雙指 pinch 縮放／放大後拖移平移**；+/- 按鈕；下方頁碼 chips、**上頁／下頁**；多檔 tabs。縮放最高約 **12×**（高 DPI 重繪）。左右方向鍵換頁。
8. 地圖參考 PDF／圖片縮放最高約 **8×**。
9. 左下目錄列：**「展開目錄」／「收起目錄」** 切換完整屬性表。

## 傳統 GPKG 工作流程

1. 開啟你的 `.gpkg` / `.geojson`（或匯入 Excel／地圖 PDF）。
2. 點選地圖上的樹木 → 左下顯示屬性；右側 PDF／媒體仍可獨立瀏覽（可選「只顯示呢棵樹」篩選）。
3. 按 **媒體資料夾** 載入調查 PDF 與現場相片（檔案不出裝置；可獨立匯入，唔使對應地圖列表）。
4. 需要時可標紅、移動點位、另存、匯出目錄（沿用上游能力）。

GPKG 開啟／拖放流程維持不變，可與 Excel／地圖 PDF 並存使用（清除全部會一併清掉）。

## 媒體匯入（獨立 PDF 庫）

- 按 **媒體資料夾**（或側欄）選 PDF；支援檔案 App（Android／iOS）
- **唔使**對應地圖或樹木清單；匯入後預設「全部媒體」；右側只顯示 **PDF 頁面**（pdf.js canvas）
- 多個 PDF → tabs 選檔，再以頁碼 chips 揀頁；**Excel 清單、地圖 PDF、調查 PDF 三者互不阻擋**
- 狀態列會顯示載入數量；0 個檔／無權限會有清楚提示

### 可選：檔名前綴篩選

若想用「只顯示呢棵樹」，可用檔名前綴配對（例如 `T1_report.pdf`）。唔係匯入必要條件。

## 資料夾結構

```
gpkg-viewer-media/
  start.py / start.bat / start.sh   本機伺服器
  index.html                        畫面（含媒體面板、匯入按鈕）
  app.js                            地圖／GPKG 引擎＋Excel 圖層載入
  media.js                          PDF 頁面（pdf.js canvas）＋配對邏輯
  import-extras.js                  Excel／CSV 解析＋樹木清單＋地圖 PDF＋加樹標註
  styles.css                        含 iPad 左右分欄
  samples/                          示範 GPKG／CSV／媒體
  templates/                        目錄 Excel 範本
  vendor/                           Leaflet + GeoPackage JS + wasm + SheetJS + pdf.js
```

## 與上游的差異（摘要）

| 項目 | 說明 |
|---|---|
| 佈局 | 新增右側媒體欄；橫向約 50/50；可 **隱藏媒體**；媒體可獨立匯入（全部媒體／只顯示呢棵樹） |
| 選樹 | `selectMarker` → `GpkgMedia.setSelectedTree` |
| 無 GPKG | **匯入 Excel**、**匯入地圖 PDF**、樹木清單、**加樹模式**（自動／手動編號＋x／y） |
| 持久化 | 樹木清單／標記 autosave → `localStorage`（地圖檔需再匯入） |
| 清單編輯 | 內嵌改 ID／DBH／H／S／Species／Remarks（與屬性卡同步） |
| 樣本 | `?demo=1` 深層連結（非主 UI）；`samples/` 保留 |
| PDF 閱讀 | 右側 pdf.js canvas 高清晰度頁面＋頁碼 chips／上／下頁（無相片列） |
| 清單 vs 地圖 | Excel／樹木清單與地圖 PDF 匯入互不依賴、互不阻擋 |
| UI 文案 | 中英對照（繁體中文為主） |
| 啟動 | 仍用 Python 本機伺服器（同上游） |

## 限制

- PDF 多頁跳轉依賴瀏覽器內建 PDF 檢視（`#page=`）；頁數以本機檔案啟發式估算（唔另加 pdf.js）；部分流動瀏覽器預覽較弱
- 相片／調查 PDF／地圖參考支援 **放大／縮小／重設**（transform scale；相片／地圖參考約至 **8×**、調查 PDF 約至 **12×**；iframe／object 原生縮放有限故採外層 scale）
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
