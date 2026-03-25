/// <reference types="chrome" />

/**
 * TamperFish Chrome Extension - Background Service Worker
 * 处理扩展图标点击、侧边栏控制和标签页监听。
 */

// 当标签页导航到 goofish.com/im 时启用侧边栏
chrome.tabs.onUpdated.addListener(
    (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
        if (changeInfo.status === 'complete' && tab.url?.includes('goofish.com/im')) {
            chrome.sidePanel.setOptions({
                tabId,
                enabled: true,
                path: 'side_panel.html',
            });
        }
    }
);

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener(
    (
        msg: { action: string },
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: { ok: boolean }) => void
    ) => {
        if (msg.action === 'openSidePanel') {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tabId = tabs[0]?.id;
                if (tabId !== undefined) {
                    chrome.sidePanel.open({ tabId });
                }
            });
            sendResponse({ ok: true });
        }
        return true;
    }
);
