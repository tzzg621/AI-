// icons.js — SVG 图标映射表

const iconMap = {

    // 音乐图标：音符用主色，线条用浅色
    musicPage: (options = {}) => {
        const { 
            primary = '#4caf50',    // 默认绿色
            secondary = '#a5d6a7',  // 默认浅绿
            size = 28 
        } = options;
        return `<svg width="${size}" height="${size}" viewBox="0 0 28 28">
            <ellipse cx="18.5" cy="19" rx="3.2" ry="2.8" fill="${primary}" opacity="0.9"/>
            <path d="M21.7 19V6.5l-11 2.8v10.7" stroke="${primary}" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.9"/>
            <path d="M10.7 9.3L21.7 6.5" stroke="${secondary}" stroke-width="1.8" stroke-linecap="round" opacity="0.6"/>
        </svg>`;
    }

};

export function getSvgIcon(moduleId, customOptions = {}) {
    const fn = iconMap[moduleId];
    if (!fn) return null;
    // 合并模块自身的默认配色和外部传入的自定义选项
    return fn(customOptions);
}
