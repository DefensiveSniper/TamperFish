/**
 * utils.ts — 通用工具函数
 *
 * 提取到独立模块以打破 index.ts ↔ crawler.ts 的循环依赖：
 * index.ts 和 crawler.ts 都需要 startSerialLoop，但 index.ts 又 import crawler.ts。
 */

/**
 * 以串行方式启动一个浏览器端轮询循环，保证上一次执行结束后才会安排下一次，
 * 避免多个定时任务排队挤爆主线程。
 * @param runner - 单次轮询执行函数。
 * @param intervalMs - 两次执行之间的等待间隔（毫秒）。
 * @param options - 可选配置，immediate 为 true 时立即先执行一次。
 */
export function startSerialLoop(
    runner: () => Promise<void> | void,
    intervalMs: number,
    options: { immediate?: boolean } = {}
): void {
    const { immediate = true } = options;

    const tick = async (): Promise<void> => {
        try {
            await runner();
        } catch (error) {
            const err = error as Error;
            console.warn('[XM] serial loop failed:', err.message || error);
        } finally {
            window.setTimeout(tick, intervalMs);
        }
    };

    window.setTimeout(tick, immediate ? 0 : intervalMs);
}
