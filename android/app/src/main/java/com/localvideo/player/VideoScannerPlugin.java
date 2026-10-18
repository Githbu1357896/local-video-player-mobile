package com.localvideo.player;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Size;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.FileOutputStream;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 扫描手机中的全部视频（MediaStore），供 WebView 里的播放器使用。
 * JS 侧调用：Capacitor.Plugins.VideoScanner.listVideos()
 * 返回：{ videos: [ { id, name, path, uri, duration, size, width, height, folder } ], count }
 */
@CapacitorPlugin(name = "VideoScanner")
public class VideoScannerPlugin extends Plugin {

    private static final int REQUEST_VIDEO_PERMISSION = 2101;
    private PluginCall pendingCall;
    // 当前挂起的调用是否为"流式扫描"（授权回调据此决定是否边扫边推送进度）
    private boolean pendingStreaming = false;

    /** 当前系统需要的读视频权限 */
    private static String requiredPermission() {
        // Android 13 (API 33) 起，外部存储的读权限被拆分为细粒度媒体权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return Manifest.permission.READ_MEDIA_VIDEO;
        }
        return Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    @PluginMethod
    public void listVideos(PluginCall call) {
        String permission = requiredPermission();

        if (hasPermission(permission)) {
            collectVideos(call, false);
            return;
        }

        pendingCall = call;
        pendingStreaming = false;
        ActivityCompat.requestPermissions(
                getActivity(),
                new String[]{permission},
                REQUEST_VIDEO_PERMISSION
        );
    }

    /**
     * 流式扫描：边遍历媒体库边通过 notifyListeners('videoScanProgress') 推送已发现的文件夹，
     * 让前端实时展示扫描进度。最终仍以 call.resolve 返回完整视频列表（前端据此做一次准确渲染）。
     * 事件载荷：
     *   { type:'folder', folder:{ path, name, count, totalDuration, preview } }  —— 新发现一个文件夹
     *   { type:'update', folder:{ ... } }                                        —— 某文件夹数量/时长刷新（限流）
     */
    @PluginMethod
    public void scanVideos(PluginCall call) {
        String permission = requiredPermission();

        if (hasPermission(permission)) {
            collectVideos(call, true);
            return;
        }

        pendingCall = call;
        pendingStreaming = true;
        ActivityCompat.requestPermissions(
                getActivity(),
                new String[]{permission},
                REQUEST_VIDEO_PERMISSION
        );
    }

    /** 查询当前是否已获得权限 */
    @PluginMethod
    public void checkPermission(PluginCall call) {
        String permission = requiredPermission();
        JSObject ret = new JSObject();
        ret.put("granted", hasPermission(permission));
        ret.put("permission", permission);
        call.resolve(ret);
    }

    /** 主动打开系统设置中的应用详情页，供用户手动授权 */
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getActivity().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法打开设置页: " + e.getMessage());
        }
    }

    /** 退出应用（供 Web 层在"最顶层主页按系统返回键"时调用） */
    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().finish());
        call.resolve();
    }

    /**
     * 锁定/解锁屏幕方向，避免靠 CSS transform 旋转视频导致 Android WebView 黑屏（音频仍在播）。
     * mode: "portrait" | "landscape" | "unlocked"
     * 必须在主线程调用 setRequestedOrientation，否则会抛 "Only the original thread..."。
     */
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String mode = call.getString("orientation", "unlocked");
        final int orientation;
        switch (mode) {
            case "portrait":
                // 必须用 PORTRAIT 而不是 USER_PORTRAIT：
                // USER_PORTRAIT 会受系统"锁定旋转"影响，用户关了自动旋转时不会转回来。
                orientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
                break;
            case "landscape":
                // 必须用 LANDSCAPE 而不是 SENSOR_LANDSCAPE：
                // SENSOR_LANDSCAPE 只是"允许横屏"，手机竖着拿时根本不会转，
                // 表现为点了全屏/返回没反应。LANDSCAPE 才是强制切到横屏。
                orientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
                break;
            default:
                orientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
                break;
        }
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(orientation);
        });
        call.resolve();
    }

    @Override
    public boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != REQUEST_VIDEO_PERMISSION || pendingCall == null) {
            return;
        }

        PluginCall call = pendingCall;
        pendingCall = null;
        boolean streaming = pendingStreaming;
        pendingStreaming = false;

        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            // 关键修复：本回调运行在 UI 线程。首次扫描走此路径，若直接在这里做 MediaStore 查询 +
            // notifyListeners，会阻塞主线程 → 界面卡住/黑屏、文件夹不显示。
            // 改到 Capacitor 桥的后台线程执行，和"已授权时的二次扫描"完全一致。
            getBridge().execute(() -> collectVideos(call, streaming));
        } else {
            JSObject ret = new JSObject();
            ret.put("videos", new JSArray());
            ret.put("count", 0);
            ret.put("permissionDenied", true);
            call.resolve(ret);
        }
    }

    private void resolveWithVideoList(PluginCall call) {
        collectVideos(call, false);
    }

    /** 遍历媒体库读取全部视频；emitProgress 为真时按文件夹实时推送进度事件 */
    private void collectVideos(PluginCall call, boolean emitProgress) {
        JSArray videos = new JSArray();
        // 流式扫描时按"首次出现顺序"聚合文件夹，用于实时推送
        final java.util.LinkedHashMap<String, FolderAgg> folderMap =
                emitProgress ? new java.util.LinkedHashMap<String, FolderAgg>() : null;
        final int[] sinceFlush = {0}; // update 事件限流计数

        Uri collection;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
        } else {
            collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        }

        String[] projection = new String[]{
                MediaStore.Video.Media._ID,
                MediaStore.Video.Media.DISPLAY_NAME,
                MediaStore.Video.Media.DATA,
                MediaStore.Video.Media.DURATION,
                MediaStore.Video.Media.SIZE,
                MediaStore.Video.Media.WIDTH,
                MediaStore.Video.Media.HEIGHT,
                MediaStore.Video.Media.BUCKET_DISPLAY_NAME,
                // RELATIVE_PATH 在 API 29+ 才有；老系统该列缺失，getColumnIndex 返回 -1，读取时自动跳过。
                MediaStore.Video.Media.RELATIVE_PATH
        };

        // 过滤掉 0 长度、损坏或尚未写完的条目
        String selection = MediaStore.Video.Media.DURATION + " > ? AND " +
                MediaStore.Video.Media.SIZE + " > ?";
        String[] selectionArgs = new String[]{"0", "0"};
        String sortOrder = MediaStore.Video.Media.DATE_MODIFIED + " DESC";

        ContentResolver resolver = getContext().getContentResolver();

        Cursor cursor = null;
        try {
            cursor = resolver.query(collection, projection, selection, selectionArgs, sortOrder);
            if (cursor == null) {
                call.reject("无法查询媒体库");
                return;
            }

            int idCol = cursor.getColumnIndex(MediaStore.Video.Media._ID);
            int nameCol = cursor.getColumnIndex(MediaStore.Video.Media.DISPLAY_NAME);
            int dataCol = cursor.getColumnIndex(MediaStore.Video.Media.DATA);
            int durCol = cursor.getColumnIndex(MediaStore.Video.Media.DURATION);
            int sizeCol = cursor.getColumnIndex(MediaStore.Video.Media.SIZE);
            int widthCol = cursor.getColumnIndex(MediaStore.Video.Media.WIDTH);
            int heightCol = cursor.getColumnIndex(MediaStore.Video.Media.HEIGHT);
            int bucketCol = cursor.getColumnIndex(MediaStore.Video.Media.BUCKET_DISPLAY_NAME);
            int relCol = cursor.getColumnIndex(MediaStore.Video.Media.RELATIVE_PATH);

            while (cursor.moveToNext()) {
                long id = idCol >= 0 ? cursor.getLong(idCol) : 0L;
                String dataPath = safeString(cursor, dataCol);
                JSObject item = new JSObject();
                item.put("id", id);
                item.put("name", safeString(cursor, nameCol));
                item.put("path", dataPath);
                item.put("uri", ContentUris.withAppendedId(collection, id).toString());
                item.put("duration", (durCol >= 0 ? cursor.getLong(durCol) : 0L) / 1000);
                item.put("size", sizeCol >= 0 ? cursor.getLong(sizeCol) : 0L);
                item.put("width", widthCol >= 0 ? cursor.getInt(widthCol) : 0);
                item.put("height", heightCol >= 0 ? cursor.getInt(heightCol) : 0);
                item.put("folder", safeString(cursor, bucketCol));
                // 完整文件夹路径（用于分组归类）：优先 DATA 父目录，其次 RELATIVE_PATH，再退化到文件夹名
                String folderPath = computeFolderPath(dataPath, safeString(cursor, relCol), safeString(cursor, bucketCol));
                item.put("folderPath", folderPath);
                videos.put(item);

                if (emitProgress) {
                    long durSec = (durCol >= 0 ? cursor.getLong(durCol) : 0L) / 1000;
                    FolderAgg agg = folderMap.get(folderPath);
                    if (agg == null) {
                        agg = new FolderAgg(folderPath, lastSegment(folderPath), item, durSec);
                        folderMap.put(folderPath, agg);
                        // 每识别到一个新文件夹，立即推送到前端实时展示
                        notifyListeners("videoScanProgress", wrapProgress("folder", agg.toJS()));
                    } else {
                        agg.count++;
                        agg.totalDuration += durSec;
                        if (++sinceFlush[0] >= 6) { // 限流：每累计 6 个视频刷新一次计数
                            sinceFlush[0] = 0;
                            notifyListeners("videoScanProgress", wrapProgress("update", agg.toJS()));
                        }
                    }
                }
            }
        } catch (Exception e) {
            call.reject("扫描视频失败: " + e.getMessage());
            return;
        } finally {
            if (cursor != null && !cursor.isClosed()) {
                cursor.close();
            }
        }

        JSObject ret = new JSObject();
        ret.put("videos", videos);
        ret.put("count", videos.length());
        ret.put("permissionDenied", false);
        call.resolve(ret);
    }

    private static String safeString(Cursor cursor, int columnIndex) {
        if (columnIndex < 0) return "";
        String value = cursor.getString(columnIndex);
        return value == null ? "" : value;
    }

    /**
     * 生成视频缩略图（供媒体库列表/卡片懒加载）。
     * JS 侧调用：Capacitor.Plugins.VideoScanner.getThumbnail({ id, width, height })
     * 返回：{ uri } —— 成功为缓存 JPEG 的 file:// URI；失败为 ""（前端据此显示占位图）。
     * 说明：本方法运行在 Capacitor 桥线程（非 UI 线程），可直接做 IO；
     *   API 29+ 用 ContentResolver.loadThumbnail，老系统降级到 MediaStore.Video.Thumbnails。
     */
    @PluginMethod
    public void getThumbnail(PluginCall call) {
        long id = call.getInt("id", 0);
        int width = call.getInt("width", 480);
        int height = call.getInt("height", 480);
        if (id <= 0 || width <= 0 || height <= 0) {
            resolveEmptyThumbnail(call);
            return;
        }

        Bitmap bitmap = null;
        try {
            Uri uri = ContentUris.withAppendedId(videoCollectionUri(), id);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    bitmap = getContext().getContentResolver().loadThumbnail(uri, new Size(width, height), null);
                } catch (Exception e) {
                    bitmap = null; // 降级到 Thumbnails
                }
            }
            if (bitmap == null) {
                bitmap = android.provider.MediaStore.Video.Thumbnails.getThumbnail(
                        getContext().getContentResolver(), id,
                        android.provider.MediaStore.Video.Thumbnails.MINI_KIND, null);
            }
        } catch (Exception e) {
            bitmap = null;
        }

        if (bitmap == null) {
            resolveEmptyThumbnail(call);
            return;
        }

        String filePath = saveThumbnailToCache(bitmap, id);
        bitmap.recycle();
        if (filePath == null) {
            resolveEmptyThumbnail(call);
            return;
        }

        JSObject ret = new JSObject();
        ret.put("uri", Uri.fromFile(new File(filePath)).toString());
        call.resolve(ret);
    }

    /** 视频 MediaStore 集合 Uri（按系统版本区分） */
    private static Uri videoCollectionUri() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
        }
        return MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
    }

    /**
     * 完整文件夹路径：优先取文件路径的父目录；缺失时用 RELATIVE_PATH（形如 "DCIM/Camera/"，
     * 去掉结尾斜杠）；再退化到文件夹显示名。用于前端把视频按所在文件夹归类。
     */
    private static String computeFolderPath(String dataPath, String relativePath, String bucketName) {
        if (!TextUtils.isEmpty(dataPath)) {
            int idx = dataPath.lastIndexOf('/');
            if (idx > 0) {
                return dataPath.substring(0, idx);
            }
        }
        if (!TextUtils.isEmpty(relativePath)) {
            String p = relativePath;
            while (p.endsWith("/")) {
                p = p.substring(0, p.length() - 1);
            }
            if (!p.isEmpty()) return p;
        }
        return bucketName == null ? "" : bucketName;
    }

    /** 取路径最后一段作为显示名 */
    private static String lastSegment(String path) {
        if (path == null || path.isEmpty()) return "未分类";
        int idx = path.lastIndexOf('/');
        String s = idx >= 0 ? path.substring(idx + 1) : path;
        return s.isEmpty() ? path : s;
    }

    /** 包装进度事件载荷：{ type, folder } */
    private static JSObject wrapProgress(String type, JSObject folder) {
        JSObject w = new JSObject();
        w.put("type", type);
        w.put("folder", folder);
        return w;
    }

    /** 流式扫描时的文件夹聚合（保持首次出现顺序） */
    private static class FolderAgg {
        final String path;
        final String name;
        final JSObject preview; // 该文件夹首个视频（用作卡片预览）
        long count;
        long totalDuration;

        FolderAgg(String path, String name, JSObject preview, long duration) {
            this.path = path;
            this.name = name;
            this.preview = preview;
            this.count = 1;
            this.totalDuration = duration;
        }

        JSObject toJS() {
            JSObject o = new JSObject();
            o.put("path", path);
            o.put("name", name);
            o.put("count", count);
            o.put("totalDuration", totalDuration);
            o.put("preview", preview);
            return o;
        }
    }

    /** 把缩略图写入缓存目录 thumbnails/thumb_<id>.jpg，返回绝对路径；失败返回 null */
    private String saveThumbnailToCache(Bitmap bitmap, long id) {
        FileOutputStream out = null;
        try {
            File dir = new File(getContext().getCacheDir(), "thumbnails");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File file = new File(dir, "thumb_" + id + ".jpg");
            out = new FileOutputStream(file);
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out);
            out.flush();
            return file.getAbsolutePath();
        } catch (Exception e) {
            return null;
        } finally {
            if (out != null) {
                try { out.close(); } catch (Exception ignored) { }
            }
        }
    }

    private void resolveEmptyThumbnail(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("uri", "");
        call.resolve(ret);
    }
}
