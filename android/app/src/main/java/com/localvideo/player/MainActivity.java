package com.localvideo.player;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件必须在 super.onCreate() 之前注册，
        // 否则 Bridge 初始化时拿不到插件列表，JS 侧调用会报 "not implemented"。
        registerPlugin(VideoScannerPlugin.class);
        super.onCreate(savedInstanceState);

        // 接管系统返回键（物理返回键 / 手势返回 / 预测性返回）。
        // 通过 OnBackPressedDispatcher 注册回调，兼容各 Android 版本（含 API 33+ 预测性返回）；
        // 本回调为唯一启用项，注册后即取代"默认退出 Activity"行为。
        // 回调里通过 WebView 执行 JS 派发 window 'appBackButton' 事件，交由前端决定：
        //   子界面返回上一层 / 播放中退全屏·关设置 / 仅最顶层主页才退出应用。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge != null) {
                    bridge.eval("window.dispatchEvent(new Event('appBackButton'))", null);
                }
            }
        });
    }
}
