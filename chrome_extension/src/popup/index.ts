/// <reference types="chrome" />

/**
 * TamperFish Chrome Extension - Popup Script
 * 显示扩展状态信息。
 */

const hint = document.getElementById('hint') as HTMLElement | null;

/**
 * 获取当前 goofish.com 标签页（如果有）。
 */
async function getGoofishTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/im*' });
    return tabs.length > 0 ? (tabs[0] ?? null) : null;
}

// 初始化：检测 goofish.com 标签页
(async (): Promise<void> => {
    const tab = await getGoofishTab();
    if (!tab) {
        if (hint) {
            hint.textContent = '未检测到 goofish.com/im 标签页，请先打开闲鱼 IM 页面。';
        }
    } else {
        if (hint) {
            hint.textContent = '内嵌浮窗已在 goofish.com 页面中运行。';
        }
    }
})();
