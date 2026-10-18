# 手机版安装与使用说明书

项目路径：`F:\Steam\local-video-player-mobile`

---

## 一、这个 App 是怎么搭起来的

界面层是**纯网页**：`www/` 里的 `index.html` / `styles.css` / `app.js`，不依赖 Electron、Node，也没用任何前端框架。

外壳是 **Capacitor 7**：把这套网页塞进 Android WebView，并提供 JS ↔ 原生的桥。视频扫描走自己写的原生插件 `VideoScannerPlugin.java`（读 MediaStore），不走网页的 File API —— 所以能拿到全机视频。

好处是**改界面不用重新编译 APK 逻辑**：网页部分改完同步一次即可，原生部分不动。

已经帮你做好的事：

| 已完成                | 说明                                                                    |
| ------------------ | --------------------------------------------------------------------- |
| Capacitor 7.6.9 工程 | `android/` 目录已是完整的 Android Studio 工程                                  |
| 视频扫描插件             | `VideoScannerPlugin.java`，调用 MediaStore 扫描全机视频                        |
| 权限配置               | `AndroidManifest.xml` 已加 `READ_MEDIA_VIDEO` / `READ_EXTERNAL_STORAGE` |
| 界面适配               | `www/` 已改为移动端：移除 Electron 依赖、懒加载、安全区适配                                |

**还差最后一步：编译。** 这台机器上没有 Android SDK（JDK 也还是 1.8，Capacitor 7 要求 **JDK 21**），所以我没法在这里直接给你产出 APK。你按下面步骤操作，第一次约 30–40 分钟，之后每次改界面 1 分钟。

---

## 二、环境准备（只需做一次）

### 1. 安装 JDK 21

> Capacitor 7 硬性要求 JDK 21，装 17 或 8 都会编译失败。

下载地址（选 Windows x64 Installer）：  
<https://adoptium.net/zh-CN/temurin/releases/?version=21>

安装完成后，设置环境变量（系统的，不是用户级也行）：

```powershell
# 右键"此电脑" → 属性 → 高级系统设置 → 环境变量 → 新建系统变量
JAVA_HOME = C:\Program Files\Eclipse Adoptium\jdk-21.x.x.x-hotspot
```

验证：

```powershell
java -version
# 应输出 openjdk version "21.x.x"
```

### 2. 安装 Android Studio

<https://developer.android.com/studio>

安装时选 **Standard**，让它自动下载 Android SDK（约 3–5 GB，全程需要联网）。

装完打开 Android Studio → **More Actions → SDK Manager**，确认已勾选：

- Android SDK Platform **35**（或更高）
- Android SDK Build-Tools **35.x**
- Android SDK Platform-Tools

记录 SDK 路径（默认一般是 `C:\Users\你的用户名\AppData\Local\Android\Sdk`）。

### 3. 设置 ANDROID_HOME

```powershell
# 系统环境变量，新建
ANDROID_HOME = C:\Users\你的用户名\AppData\Local\Android\Sdk
```

如果不想设系统变量，也可以在 `android/local.properties` 里写一行（文件需要你自己新建）：

```
sdk.dir=C:\\Users\\你的用户名\\AppData\\Local\\Android\\Sdk
```

注意路径里的反斜杠要写成双反斜杠。

---

## 三、把 App 装到手机上

### 方式 A：Android Studio 一键运行（推荐，最省事）

1. 打开 Android Studio → **File → Open**
2. 选择目录 `F:\Steam\local-video-player-mobile\android`，点 OK
3. 等待右下角 Gradle 同步完成（首次 5–15 分钟，需要联网下载依赖）
4. **手机打开开发者选项 + USB 调试**，用数据线连电脑
   - 开发者选项：设置 → 关于手机 → 连点"版本号"7 次
   - USB 调试：设置 → 系统 → 开发者选项 → 打开
   - 部分手机还需要打开"USB 安装"或"允许通过 USB 安装应用"
5. 顶部设备下拉框应能看到你的手机型号，选中它
6. 点绿色 ▶ Run 按钮

App 会自动安装到手机并开始调试运行。**推荐第一次用这种方式**，出问题能直接在 Logcat 里看到原因。

### 方式 B：生成 APK 文件，手动拷到手机安装

```powershell
cd F:\Steam\local-video-player-mobile\android
.\gradlew assembleDebug
```

首次会下载 Gradle 发行版和依赖，耐心等。成功后 APK 在：

```
F:\Steam\local-video-player-mobile\android\app\build\outputs\apk\debug\app-debug.apk
```

把这个文件发到手机（微信 / QQ / U盘 / 数据线都行），在手机上点开安装。如果系统拦，选择"继续安装"即可。

> 国内部分手机会提示"存在风险"，属于正常现象 —— 因为这个 APK 没用正式签名。

### 方式 C：命令行无线安装（手机和电脑同一 WiFi）

```powershell
cd F:\Steam\local-video-player-mobile\android
.\gradlew installDebug
```

前提是已用方式 A 连过一次并被授权。

---

## 四、使用说明

### 首次启动

1. 打开 App，看到黑底首页，点 **「扫描手机视频」**
2. 首次会弹系统权限框 → 点 **「允许」**
   - Android 13+ 要的是"读取视频文件"
   - Android 12 及以下要的是"读取存储空间"
3. 如果点了"拒绝"，首页会提示未授权，此时点按钮会跳转到系统设置页手动开启
4. 授权后自动列出手机里全部视频（按最近修改时间倒序），直接进入播放

### 播放操作

| 操作                    | 效果                                                       |
| --------------------- | -------------------------------------------------------- |
| **上下滑动**              | 切换到上一个 / 下一个视频（全屏旋转后变成**左右滑动**）                          |
| **单击画面**              | 显示 / 隐藏控制栏（标题栏、进度条、全屏提示一起收起或展开）                          |
| **双击画面中间**            | 播放 / 暂停                                                  |
| **双击画面左边缘 30%**       | 快退 15 秒，弹出 `<< -15 秒`                                    |
| **双击画面右边缘 30%**       | 快进 15 秒，弹出 `>> +15 秒`                                    |
| **播放中静置 3 秒**         | 控制栏与所有图标自动隐藏，点一下恢复；暂停时始终显示，拖进度条时也不会隐藏                   |
| **拖动底部进度条**           | 跳转到指定时间                                                  |
| **点右下角图标**（两条横线那个）    | 从底部弹出设置面板                                                |
| **画面下方「全屏观看」提示**      | 横屏视频才会出现。点击后**整个播放器界面**旋转 90° 铺满竖屏 —— 标题栏、控制栏、暂停图标全部跟着转，不再是只转视频本身；再点一次（按钮此时变成「退出全屏」）恢复 |

> 全屏后左右会产生两套方向：想换视频就沿着画面的上下方向滑（在屏幕上就是左右滑），快进/快退区也跟着转到画面左右两侧。

### 设置面板

| 项目      | 说明                                             |
| ------- | ---------------------------------------------- |
| 倍速      | 循环切换 0.5X / 0.75X / 1.0X / 1.25X / 1.5X / 2.0X |
| 开启画中画模式 | 需要系统 WebView 支持，不支持会提示                         |
| 亮度滑块    | 在视频上盖一层黑色遮罩，调暗画面                               |
| 音量滑块    | 调节播放音量                                         |

---

## 五、改了界面之后怎么更新

改 `www/` 里的文件（不要改 `android/app/src/main/assets/public/`，那个是自动拷过去的），然后：

```powershell
cd F:\Steam\local-video-player-mobile
npx cap sync android
```

再回到 Android Studio 点 ▶ Run，或重新 `gradlew assembleDebug`。

只改 Java 插件代码时不需要 sync，直接编译即可。

---

## 六、常见问题

**Q：Gradle 同步卡住 / 报错 "Could not resolve"**  
一般是网络问题。在 Android Studio 里 File → Settings → Appearance & Behavior → System Settings → HTTP Proxy 配置代理，或给 Gradle 加国内镜像（编辑 `android/build.gradle`，把 `google()` / `mavenCentral()` 换成阿里云镜像）。

**Q：编译报错 "Unsupported class file major version"**  
JDK 版本不对。Capacitor 7 必须用 JDK 21。确认 `JAVA_HOME` 指向 21，并在 Android Studio 里：File → Project Structure → SDK Location → JDK location 也选到 JDK 21。

**Q：App 打开后点扫描没反应 / 一直提示没有视频**

- 确认已授予存储权限
- 确认手机里确实有本地视频文件（不是云端缩略图）
- 部分厂商 ROM 会限制第三方 App 读 DCIM，在系统设置里给这个 App 单独开权限

**Q：视频能列出来但是播不了 / 黑屏**  
少数老旧格式的编码 Android 不支持（比如某些 RMVB、HEVC 高码率）。换 MP4 试试。

**Q：想改 App 名字或图标**

- 名字：`android/app/src/main/res/values/strings.xml` 里的 `app_name`
- 图标：替换 `android/app/src/main/res/mipmap-*/ic_launcher.png`

**Q：想发布到应用商店**  
需要正式签名。用 Android Studio → Build → Generate Signed Bundle / APK，创建 keystore 后用 `gradlew bundleRelease` 生成 `.aab`。**keystore 一定要备份**，丢了就无法更新应用。

---

## 七、目录结构

```
local-video-player-mobile/
├─ www/                                  ← 网页层，改界面改这里
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ android/                              ← Android 原生工程
│  └─ app/src/main/
│     ├─ AndroidManifest.xml             ← 权限在这里
│     ├─ assets/public/                  ← 自动同步的副本，不要手改
│     └─ java/com/localvideo/player/
│        ├─ MainActivity.java            ← 在这里注册原生插件
│        └─ VideoScannerPlugin.java      ← 视频扫描插件
├─ tools/                                ← 本机验证脚本（与打包无关）
│  ├─ verify-chrome.js                   ← 无头 Chrome 跑运行时验证并截图
│  └─ mock-capacitor.js                  ← 假的原生桥，让网页能在电脑上跑起来
├─ capacitor.config.json
└─ package.json
```

想在电脑上先验证界面再打包：

```powershell
node tools/verify-chrome.js
```

会用无头 Chrome 加载 `www/`，注入假桥跑一遍扫描、播放、控制栏隐藏、全屏旋转，
结果写进 `verify.log`，并生成 `preview-mobile-*.png` 截图。

