# GeoPackage Viewer · 樹木媒體面板

離線 GeoPackage（`.gpkg`）檢視器，專為園藝／樹木調查工作流而設：**地圖＋屬性＋直放相片＋PDF 頁碼**。  
改編自上游 [hugoleung04/gpkg-viewer](https://github.com/hugoleung04/gpkg-viewer)（本機無寫入上游權限；此資料夾為獨立 fork）。

- 檔案只在瀏覽器本機讀取，不上傳
- 適合 **iPad mini 橫向**：左半地圖／屬性，右半媒體
- 相片按樹木編號配對（例如 `T1` → `T1_*.jpg`）
- 無需真實 GPKG 亦可進入示範模式試 UI

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

### 示範（無需自備 GPKG）

啟動後開啟：

```
http://127.0.0.1:8765/?demo=1
```

會載入示範樹木 **T1 / T2 / T8 / T30** 與內建示範相片／PDF。  
亦可在畫面上按 **「示範樹木」**、**「示範媒體」**。

若要改載上游河流樣本 GPKG：`?demo=1&trees=0`

## iPad mini 使用提示

1. 電腦執行 `start.py` 後，終端機會顯示區網位址（例如 `http://192.168.x.x:8765/`）。
2. iPad 與電腦同一 Wi‑Fi，用 **Safari** 開啟該位址。
3. 建議 **橫向（landscape）**：左約 50% 地圖＋樹木資料，右約 50% 相片／PDF。
4. 可選：Safari 分享 → **加入主畫面**（PWA）。
5. 開啟 `.gpkg`：先存入「檔案」App，再按 **開啟 GPKG** → 瀏覽。
6. 相片／PDF：按 **媒體資料夾**，一次選取多個檔案（Safari 支援多選）。
7. 相片操作：左右掣或左右滑動；顯示檔名與 `2 / 4`。
8. PDF：號碼掣 `#07`、`#08`；上方顯示 **現在第 8 / 20 頁**（示範可模擬跳頁；真實 PDF 會嘗試 `#page=`）。

## 工作流程

1. （可選）按 **示範樹木** 或開啟你的 `.gpkg` / `.geojson`。
2. 點選地圖上的樹木 → 左下顯示屬性，右側顯示該樹相片。
3. 按 **媒體資料夾** 載入現場相片與調查 PDF（檔案不出裝置）。
4. 需要時可標紅、移動點位、另存、匯出目錄（沿用上游能力）。

## 相片命名（PhotoRenamer）

媒體面板用**檔名前綴**配對樹木編號：

| 樹木編號 | 建議檔名例子 |
|---|---|
| T1 | `T1_001.jpg`、`T1_defect.jpg`、`T1_crown.jpg` |
| T30 | `T30_001.jpg`、`T30_base.jpg` |

規則：

- 格式：`{TreeID}_{說明}.{jpg|png|webp…}`
- `TreeID` 與 GPKG／屬性表的編號欄一致（常用 `Tree ID`、`tree_no` 等；地圖標籤欄可在側欄選擇）
- 可用同伴工具 **PhotoRenamer** 批次把現場相機檔名改成上述格式，再選入本檢視器
- 一個編號可有多張相片；面板每次只顯示**一張直放**（兩側留黑邊／letterbox），以符合現場直向相片為主的習慣

PDF：同一份調查報告可涵蓋多棵樹。選樹後會更新相關頁碼掣與「現在第 x / y 頁」。示範模式內建假頁碼對照；真實檔案則以本機 PDF 預覽為主。

## 資料夾結構

```
gpkg-viewer-media/
  start.py / start.bat / start.sh   本機伺服器
  index.html                        畫面（含媒體面板）
  app.js                            上游地圖／GPKG 引擎（已接上選樹回呼）
  media.js                          相片／PDF 面板與配對邏輯
  styles.css                        含 iPad 左右分欄
  samples/rivers.gpkg               上游樣本
  samples/media/                    示範相片與 PDF
  vendor/                           Leaflet + GeoPackage JS + wasm
```

## 與上游的差異（摘要）

| 項目 | 說明 |
|---|---|
| 佈局 | 新增右側媒體欄；橫向約 50/50 |
| 選樹 | `selectMarker` → `GpkgMedia.setSelectedTree` |
| 示範 | 無需 GPKG 的 demo trees + 內建媒體 |
| UI 文案 | 中英對照（繁體中文為主） |
| 啟動 | 仍用 Python 本機伺服器（同上游） |

## 限制

- PDF 多頁跳轉依賴瀏覽器內建 PDF 檢視（`#page=`）；部分流動瀏覽器預覽較弱，頁碼掣仍可作導航指示
- HEIC 等格式視系統／瀏覽器支援而定；建議 JPG／PNG
- 大型 GPKG 仍受上游「圖徵上限」影響（預設 25,000）
- 無寫入上游 repo；請在此資料夾自行備份／發佈

## 致謝

- 上游：[hugoleung04/gpkg-viewer](https://github.com/hugoleung04/gpkg-viewer)
- [NGA GeoPackage JS](https://github.com/ngageoint/geopackage-js)
- [Leaflet](https://leafletjs.com/)
