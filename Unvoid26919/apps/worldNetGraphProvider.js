// apps/worldNetGraphProvider.js
// 关系网实现选择器。
// 负责：
// 1. 选择标准版或 Demo 版
// 2. 加载对应 CSS
// 3. 记录当前容器实际挂载的实现
// 4. 保证卸载时调用正确的实现

import * as ClassicGraph from './worldNetGraph.js';
import * as DemoGraph from './worldNetGraphDemo.js';

const VERSION_KEY = 'worldnet_graph_version';
const STYLE_ID = 'worldnet-graph-style';

const mountedInstances = new WeakMap();

function normalizeVersion(version) {
    return version === 'classic'
        ? 'classic'
        : 'demo';
}

function getImplementation(version) {
    return version === 'classic'
        ? ClassicGraph
        : DemoGraph;
}

export function getWorldNetGraphVersion() {
    try {
        return normalizeVersion(
            localStorage.getItem(VERSION_KEY)
        );
    } catch (error) {
        console.warn(
            '[WorldNetGraphProvider] 读取版本设置失败:',
            error
        );

        return 'demo';
    }
}

export function setWorldNetGraphVersion(version) {
    const normalizedVersion =
        normalizeVersion(version);

    try {
        // worldnet_ 前缀会被 DataSync 接管。
        localStorage.setItem(
            VERSION_KEY,
            normalizedVersion
        );
    } catch (error) {
        console.warn(
            '[WorldNetGraphProvider] 保存版本设置失败:',
            error
        );
    }

    return normalizedVersion;
}

function getStyleHref(version) {
    const fileName =
        version === 'classic'
            ? 'worldNetGraph.css'
            : 'worldNetGraphDemo.css';

    return new URL(
        `./${fileName}`,
        import.meta.url
    ).href;
}

function ensureGraphStyle(version) {
    if (
        typeof document === 'undefined'
        || !document.head
    ) {
        return;
    }

    const href = getStyleHref(version);

    let link = document.getElementById(STYLE_ID);

    if (!link) {
        link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        link.dataset.worldnetGraphStyle = 'true';
        document.head.appendChild(link);
    }

    // 只保留一份由 Provider 管理的关系网样式。
    if (link.href !== href) {
        link.href = href;
    }
}

export function renderWorldNetGraph(options = {}) {
    const version = normalizeVersion(
        options.version
        || getWorldNetGraphVersion()
    );

    ensureGraphStyle(version);

    return getImplementation(version)
        .renderWorldNetGraph(options);
}

export function mountWorldNetGraph(
    container,
    options = {}
) {
    if (!container) return null;

    const version = normalizeVersion(
        options.version
        || getWorldNetGraphVersion()
    );

    ensureGraphStyle(version);

    const implementation =
        getImplementation(version);

    // 防止同一个容器内残留旧实例。
    const previous =
        mountedInstances.get(container);

    if (previous) {
        previous.implementation
            .unmountWorldNetGraph(container);

        mountedInstances.delete(container);
    }

    const graph =
        implementation.mountWorldNetGraph(
            container,
            options
        );

    if (graph) {
        mountedInstances.set(container, {
            version,
            implementation
        });
    }

    return graph;
}

export function unmountWorldNetGraph(container) {
    if (!container) return;

    const mounted =
        mountedInstances.get(container);

    if (!mounted) {
        // 兼容某些异常路径：即使 Provider 没有记录，
        // 两个实现的 unmount 都是幂等的，调用不会产生副作用。
        ClassicGraph.unmountWorldNetGraph(container);
        DemoGraph.unmountWorldNetGraph(container);
        return;
    }

    mounted.implementation
        .unmountWorldNetGraph(container);

    mountedInstances.delete(container);
}
