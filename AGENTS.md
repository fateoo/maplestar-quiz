# MapleStar Quiz 發佈

每次更新 GitHub Pages 時，在 `main` 發佈倉庫套用網站變更後，先執行 `python3 .github/scripts/stamp-release.py`，再將 `index.html` 和網站變更一併提交。指令會依上一個提交的版號遞增修訂版號，並將發佈時間更新為 UTC+8。同一個提交前重跑時會沿用同一個新版號。
