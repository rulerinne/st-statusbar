# st-local-statusbar

本地版 SillyTavern 状态栏扩展。

## 安装

把整个 `st-local-statusbar` 文件夹放进：

`SillyTavern/scripts/extensions/third-party/`

或者直接使用同目录下打包出的 `st-local-statusbar.zip`。

## 源文件

状态栏内容源文件仍然是根目录的 `1.txt`。

每次改完 `1.txt` 后，运行：

```powershell
python .\build_sillytavern_extension.py
```

脚本会自动同步 `statusbar.fragment.html` 并重新打包 zip。
