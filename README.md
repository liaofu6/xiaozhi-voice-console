# 小智语音控制台（xiaozhi-voice-console）

把**小智语音设备的两个本地服务**收进一个网页控制台：

- **AI 转接**：本地跑的小智服务端（语音识别 + 大模型 + 语音合成），负责设备对话
- **音乐 MCP**：网易云/QQ/酷狗取歌，给设备推 Ogg/Opus 音频流

控制台是一个零依赖的 Node 网页，点按钮即可启动/停止，不写开机自启、不常驻后台。

> 作者：liaofu ｜ MIT License

---

## 目录结构

```
xiaozhi-voice-console/
├── 启动音乐控制台.bat     # 双击这个：启动控制台并用 Edge 应用窗口打开
├── panel.js               # 控制台本体（HTTP + 网页 UI + 三个服务的进程管理）
├── _panel_launch.vbs      # 无黑窗启动辅助
├── server.js              # 音乐 MCP 服务（搜索/取址/转码/歌单）
├── meting/                # 多平台取歌（PHP，QQ/酷狗）
├── start.bat              # 只启动音乐服务（不经过控制台）
├── xiaozhi-server/
│   └── .config.example.yaml  # 小智服务端覆盖配置示例（含去 AI 味提示词）
├── .env.example
└── package.json
```

AI 转接的**服务端本体不包含在本仓库**，请自行克隆上游：
[xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)。

---

## 快速开始

### 1. 音乐 MCP

```bash
npm install
copy .env.example .env        # 按需填写
```

需要：
- Node.js 18+
- ffmpeg（控制台会自动找 `E:\ffmpeg\ffmpeg.exe`、`C:\ffmpeg\ffmpeg.exe`，也可用环境变量 `FFMPEG` 指定）
- PHP（可选，只有 QQ/酷狗需要多平台取歌）

双击 `启动音乐控制台.bat`，浏览器打开 `http://127.0.0.1:3210`。

### 2. AI 转接（小智服务端）

1. 克隆上游服务端，按它的文档建 Python venv 并安装依赖：
   ```bash
   git clone https://github.com/xinnan-tech/xiaozhi-esp32-server.git
   cd xiaozhi-esp32-server
   python -m venv .venv
   .venv\Scripts\pip install -r main/xiaozhi-server/requirements.txt
   ```
2. 复制配置：
   ```bash
   copy xiaozhi-voice-console\xiaozhi-server\.config.example.yaml ^
        xiaozhi-esp32-server\main\xiaozhi-server\data\.config.yaml
   ```
   把里面的 `websocket` 改成本机局域网 IP，`api_key` 换成自己的 DeepSeek Key。
3. 回到控制台，在「AI 转接」卡片点**启动**。首次启动要加载语音识别模型，约 1 分钟。

控制台靠这三个环境变量定位服务端（都有默认值，通常不用改）：

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `XIAOZHI_SERVER_DIR` | 小智服务端根目录 | 自动探测 `E:\`/`D:\`/`C:\xiaozhi-esp32-server` |
| `XIAOZHI_PYTHON` | 服务端 venv 的 python | `<目录>\.venv\Scripts\python.exe` |
| `XIAOZHI_WS_PORT` / `XIAOZHI_OTA_PORT` | 对话 / OTA 端口 | 8000 / 8003 |

启动后卡片上会直接显示：

- 设备 WebSocket：`ws://<局域网IP>:8000/xiaozhi/v1/`
- 设备 OTA：`http://<局域网IP>:8003/xiaozhi/ota/`

把固件里的 OTA 地址改成上面这个（或擦除 NVS 后用 `CONFIG_OTA_URL` 重新烧录），设备配网后就会连到你的电脑。

---

## 去 AI 味提示词

`xiaozhi-server/.config.example.yaml` 里的 `prompt` 用的是可执行的硬规则，不是「请像真人一样说话」这种空话：

1. **限长**：一次 1~2 句、30 字内，不许把话说完整
2. **反应先行**：先说「欸？／真的假的／笑死」，再讲观点
3. **套话黑名单**：禁「首先/其次/总之/此外/值得注意的是/作为一个AI/还有什么可以帮你」，禁分点、禁复述问题
4. **参数配合**：`temperature 0.9`、`max_tokens 300`、`frequency_penalty 0.3`

模型越强，越容易端着，这套规则主要是压它的书面腔。

---

## 控制台接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 音乐服务 / 多平台服务状态 |
| GET | `/api/ai/status` | AI 转接状态（目录、python、端口、是否在跑） |
| POST | `/api/start` `/api/stop` `/api/restart` | 音乐服务开关 |
| POST | `/api/meting/start` `/api/meting/stop` | 多平台服务开关 |
| POST | `/api/ai/start` `/api/ai/stop` | AI 转接开关 |
| GET/POST | `/api/endpoint` | 读取/保存小智 MCP 接入点 |
| GET | `/api/logs` `/api/logs/stream` | 日志（轮询 / SSE） |

音乐服务自身接口见 [server.js](server.js)：`/search`、`/stream/<id>.ogg`、`/lyric`、`/playlist/<id>.json`、`/probe`、`/oggtest`。

---

## 常见问题

**设备说「小智现在有点忙」**
大模型请求失败，最常见是 `data/.config.yaml` 里 `api_key` 还是占位符。换成真 Key 后重启 AI 转接。

**设备哑巴、日志报 `[WinError 2] 系统找不到指定的文件`**
EdgeTTS 生成的 mp3 要转 Opus，需要 `ffmpeg` 和 `ffprobe`。把两个 exe 放进 `<服务端>\.venv\Scripts\`，或加进 PATH。只放 ffmpeg 不够，pydub 探测音频信息必须用 ffprobe。

**控制台显示「未找到服务端」**
设置环境变量 `XIAOZHI_SERVER_DIR` 指向克隆下来的服务端目录（该目录下要有 `main\xiaozhi-server\app.py`）。

**端口被占用**
控制台检测到端口被别的进程占用时会显示「外部实例占用端口」，可以直接点停止强制结束。

---

## 免责声明

- 本项目仅用于个人学习与自用，音乐内容版权归各平台与版权方所有
- 不提供任何破解、绕过付费会员的功能；付费曲取不到地址属于正常行为
- 请勿将本项目用于商业用途或公开分发受版权保护的内容

## License

[MIT](LICENSE) © 2026 liaofu
