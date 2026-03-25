/// <reference types="chrome" />

/**
 * TamperFish Chrome Extension - Popup Script
 * 管理面板模式设置（侧边栏 vs 内嵌浮窗）。
 * 面板模式存储于 goofish.com 的 localStorage（key: _tamperfish_panel_mode）。
 * 使用 chrome.scripting.executeScript 在页面主世界中读写该值。
 */

/** 面板显示模式 */
type PanelMode = 'embedded' | 'sidepanel';

const embeddedToggle = document.getElementById('embeddedToggle') as HTMLInputElement | null;
const openSidePanelBtn = document.getElementById('openSidePanel') as HTMLButtonElement | null;
const hint = document.getElementById('hint') as HTMLElement | null;

/**
 * 获取当前 goofish.com 标签页（如果有）。
 * @returns Promise<chrome.tabs.Tab | null>
 */
async function getGoofishTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/im*' });
    return tabs.length > 0 ? (tabs[0] ?? null) : null;
}

/**
 * 从 goofish.com 标签页的 localStorage 读取面板模式。
 * @returns Promise<PanelMode>
 */
async function readPanelMode(): Promise<PanelMode> {
    const tab = await getGoofishTab();
    if (!tab || tab.id === undefined) return 'sidepanel';

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (): string =>
                localStorage.getItem('_tamperfish_panel_mode') || 'sidepanel',
        });
        const result = results?.[0]?.result as string | undefined;
        return result === 'embedded' ? 'embedded' : 'sidepanel';
    } catch {
        return 'sidepanel';
    }
}

/**
 * 将面板模式写入 goofish.com 标签页的 localStorage。
 * @param mode - 目标面板模式。
 */
async function writePanelMode(mode: PanelMode): Promise<void> {
    const tab = await getGoofishTab();
    if (!tab || tab.id === undefined) return;

    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (m: string): void => {
            localStorage.setItem('_tamperfish_panel_mode', m);
        },
        args: [mode],
    });
}

// 初始化：读取当前模式并同步 Toggle 状态
(async (): Promise<void> => {
    const mode = await readPanelMode();
    if (embeddedToggle) {
        embeddedToggle.checked = mode === 'embedded';
    }

    const tab = await getGoofishTab();
    if (!tab) {
        if (hint) {
            hint.textContent = '未检测到 goofish.com/im 标签页，请先打开闲鱼 IM 页面。';
        }
        if (embeddedToggle) {
            embeddedToggle.disabled = true;
        }
    }
})();

// Toggle 切换事件
if (embeddedToggle) {
    embeddedToggle.addEventListener('change', async () => {
        const mode: PanelMode = embeddedToggle.checked ? 'embedded' : 'sidepanel';
        await writePanelMode(mode);
        if (hint) {
            hint.textContent = `已切换为「${mode === 'embedded' ? '内嵌浮窗' : '侧边栏'}」模式，请刷新 goofish.com 标签页生效。`;
        }
    });
}

// 打开侧边栏
if (openSidePanelBtn) {
    openSidePanelBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openSidePanel' });
        window.close();
    });
}
