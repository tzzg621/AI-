// store/utils.js

/**
 * 动态 import 带重试
 * @param {Function} importFn - 返回 import() Promise 的函数
 * @param {number} retries - 重试次数，默认 3
 * @param {number} delay - 每次重试间隔（毫秒），默认 800
 * @returns {Promise<Module>}
 */
export async function importWithRetry(importFn, retries = 3, delay = 800) {
    for (let i = 0; i < retries; i++) {
        try {
            return await importFn();
        } catch (e) {
            if (i < retries - 1) {
                console.warn(`📦 模块加载失败，第 ${i + 1} 次重试...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw e;
            }
        }
    }
}
