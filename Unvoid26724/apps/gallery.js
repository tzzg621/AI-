// apps/gallery.js — 相册

import { getGlobalImageHtml, setGlobalImage, getImageHtml, removeImage, getImageDataUrl } from '../store/ImageCache.js';
import { showConfirm, showPrompt } from '../store/dialog.js';

export const id = 'gallery';
export const label = '相册';
export const icon = '🖼️';
export const color = '#e91e63';

const ALBUMS_KEY = 'gallery_albums';
const DEFAULT_ALBUMS = [
    { id: 'album_avatar', name: '头像', type: 'preset', images: [] },
    { id: 'album_portrait', name: '形象卡', type: 'preset', images: [] },
    { id: 'album_pixel', name: '像素头像', type: 'preset', images: [] },
    { id: 'album_pet', name: '🐱 桌宠', type: 'pet', images: [] },
];

// ---- 相册数据管理 ----
function getAlbums() {
    try {
        const saved = localStorage.getItem(ALBUMS_KEY);
        const customAlbums = saved ? JSON.parse(saved) : [];
        // 合并默认相册和自定义相册
        const merged = DEFAULT_ALBUMS.map(def => {
            const saved = customAlbums.find(a => a.id === def.id);
            return saved || def;
        });
        // 加上自定义相册（排除默认的）
        customAlbums.forEach(a => {
            if (!merged.some(m => m.id === a.id)) {
                merged.push(a);
            }
        });
        // ★ 确保回收站相册存在
        const trashIndex = merged.findIndex(a => a.id === 'album_trash');
        if (trashIndex === -1) {
            merged.push({
                id: 'album_trash',
                name: '🗑️ 回收站',
                type: 'trash',
                images: []
            });
        } else if (trashIndex !== merged.length - 1) {
            // 如果回收站不在最后，移到末尾
            const trash = merged.splice(trashIndex, 1)[0];
            merged.push(trash);
        }


        // ★ 根据全局设置过滤桌宠相册 ← 放在 return 前面
        const showPetAlbum = localStorage.getItem('global_show_pet_album') === 'true';
        return merged.filter(a => a.type !== 'pet' || showPetAlbum);

    } catch { return [...DEFAULT_ALBUMS]; }

}

function saveAlbums(albums) {
    // 只保存自定义相册 + 默认相册的 images 列表
    const toSave = albums.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type || 'custom',
        images: a.images
    }));
    localStorage.setItem(ALBUMS_KEY, JSON.stringify(toSave));
}

function generateAlbumId() {
    return 'album_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

// ---- 子页面状态 ----
let viewingAlbum = null;

// ---- 监听图片上传事件 ----
window.addEventListener('image-added', (e) => {
    const { key, type } = e.detail;
    const albums = getAlbums();

    let targetAlbum;
    if (type === 'avatar') targetAlbum = albums.find(a => a.id === 'album_avatar');
    else if (type === 'portrait') targetAlbum = albums.find(a => a.id === 'album_portrait');

    if (targetAlbum && !targetAlbum.images.includes(key)) {
        targetAlbum.images.push(key);
        saveAlbums(albums);
    }
});

window.addEventListener('image-loaded', (e) => {
    // 如果当前在相册子页面，刷新视图
    if (viewingAlbum !== null) {
        const appContainer = document.querySelector('.page-container');
        if (appContainer) {
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        }
    }
});

function renderImageByKey(key) {
    // 角色图片（头像/形象卡）
    if (key.startsWith('avatar_') || key.startsWith('portrait_')) {
        const type = key.startsWith('avatar_') ? 'avatar' : 'portrait';
        const charId = key.substring(type.length + 1); // 去掉 "avatar_" 或 "portrait_"
        return getImageHtml(charId, type, { round: type === 'avatar' });
    }
    // 全局图片（手动上传到相册的）
    return getGlobalImageHtml(key) || '<div style="width:100%; height:100%; background:#e0e0e0;"></div>';
}

// ---- 大图预览 ----
function showImagePreview(key) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; z-index:300;
        background:rgba(0,0,0,0.85); display:flex; align-items:center;
        justify-content:center; cursor:pointer;
    `;

    const img = document.createElement('img');
    img.style.cssText = `
        max-width:90%; max-height:85%; border-radius:12px;
        box-shadow:0 8px 40px rgba(0,0,0,0.5); object-fit:contain;
        cursor:default; transition:opacity 0.2s;
    `;
    img.alt = '加载中…';

    // 加载提示
    const loading = document.createElement('div');
    loading.textContent = '⏳ 加载中…';
    loading.style.cssText = 'color:#fff; font-size:14px; position:absolute;';

    overlay.appendChild(loading);
    overlay.appendChild(img);
    document.body.appendChild(overlay);

    // 异步加载原图
    getImageDataUrl(key).then(dataUrl => {
        if (dataUrl) {
            img.src = dataUrl;
            loading.remove();
        } else {
            loading.textContent = '❌ 图片数据丢失';
        }
    });

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    // 点图片也关闭
    img.addEventListener('click', () => overlay.remove());
    // ESC 关闭
    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}


// ---- 主渲染 ----
export function render() {
    const albums = getAlbums();

    // 预置相册子页面
    if (viewingAlbum === 'album_avatar' || viewingAlbum === 'album_portrait' || viewingAlbum === 'album_pixel') {
        const album = albums.find(a => a.id === viewingAlbum);
        if (album) return renderAlbumView(album);
    }

    // 自定义相册子页面
    if (viewingAlbum && viewingAlbum.startsWith('album_') && !['album_avatar', 'album_portrait', 'album_pixel'].includes(viewingAlbum)) {
        const album = albums.find(a => a.id === viewingAlbum);
        if (album) return renderAlbumView(album);
        viewingAlbum = null;
    }

    // 列表页
    return renderAlbumList(albums);
}

// ---- 渲染列表页 ----
function renderAlbumList(albums) {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">🖼️ 相册</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    ${albums.map(album => `
                        <div class="album-item" data-album="${album.id}" style="display:flex; align-items:center; gap:14px; padding:16px 18px; cursor:pointer; border-bottom:1px solid #f0f0f0;">
                            <span style="font-size:28px;">${album.type === 'preset' ? (album.id === 'album_avatar' ? '👤' : '🖼️') : '📁'}</span>
                            <div style="flex:1;">
                                <div style="font-weight:600; font-size:15px;">${album.name}</div>
                                <div style="font-size:12px; color:#999; margin-top:2px;">${album.images.length} 张图片</div>
                            </div>
                            <span style="color:#ccc; font-size:18px;">›</span>
                        </div>
                    `).join('')}

                    <div id="addAlbumBtn" style="display:flex; align-items:center; gap:14px; padding:16px 18px; cursor:pointer; color:#e91e63;">
                        <span style="font-size:28px;">➕</span>
                        <div style="font-weight:600; font-size:15px;">新建相册</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 渲染相册子页面 ----
function renderAlbumView(album) {
    const albums = getAlbums();
    const otherAlbums = albums.filter(a => a.id !== album.id);

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${album.type === 'preset' ? (album.id === 'album_avatar' ? '👤' : '🖼️') : '📁'} ${album.name}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    ${album.type !== 'preset' ? `
                        <button id="addToAlbumBtn" style="width:100%; padding:10px; border-radius:16px; border:none; background:#e91e63; color:white; cursor:pointer; font-size:14px; font-weight:600; margin-bottom:16px;">
                            ➕ 添加图片到此相册
                        </button>
                    ` : `
                        <p style="font-size:13px; color:#888; margin-bottom:12px;">此相册自动收录上传的${album.name}，不可手动添加</p>
                    `}

                    ${album.images.length === 0 ? `
                        <p style="text-align:center; color:#888; padding:30px 0;">暂无图片</p>
                    ` : `
                        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
${album.images.map(key => `
<div data-key="${key}" style="position:relative; border-radius:8px; overflow:hidden; aspect-ratio:1; background:#f0f0f0;">
    ${renderImageByKey(key)}

                <!-- ★ 下载按钮 -->
        <button class="download-img-btn" data-key="${key}" style="
            position:absolute; bottom:4px; right:4px; width:24px; height:24px; border-radius:50%;
            border:none; background:rgba(0,0,0,0.5); color:white; cursor:pointer; font-size:12px; line-height:1;
        ">⬇</button>

                ${album.id === 'album_pet' ? `
            <button class="set-pet-btn" data-key="${key}" style="
                position:absolute; bottom:4px; left:4px; width:auto; height:24px; padding:0 8px; border-radius:4px;
                border:none; background:rgba(255,152,0,0.85); color:white; cursor:pointer; font-size:10px; line-height:24px; font-weight:600;
            ">🐱 设为桌宠</button>
        ` : ''}
        
        ${album.id === 'album_trash' ? `
            <!-- 回收站：彻底删除按钮 -->
            <button class="permanent-delete-btn" data-key="${key}" style="
                position:absolute; top:4px; right:4px; width:24px; height:24px; border-radius:50%;
                border:none; background:#e53935; color:white; cursor:pointer; font-size:12px; line-height:1;
            ">×</button>
        ` : `
            <!-- 普通相册：移动 + 移到回收站 -->
            ${otherAlbums.length > 0 ? `
                <button class="move-img-btn" data-key="${key}" data-album="${album.id}" style="
                    position:absolute; top:4px; left:4px; width:24px; height:24px; border-radius:50%;
                    border:none; background:rgba(0,0,0,0.5); color:white; cursor:pointer; font-size:12px;
                ">↗</button>
            ` : ''}
            <button class="del-from-album-btn" data-key="${key}" data-album="${album.id}" style="
                position:absolute; top:4px; right:4px; width:24px; height:24px; border-radius:50%;
                border:none; background:rgba(0,0,0,0.5); color:white; cursor:pointer; font-size:14px; line-height:1;
            ">×</button>
        `}
    </div>
`).join('')}
                        </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

// ---- 选择目标相册弹窗 ----
function renderMoveDialog(currentAlbumId) {
    const albums = getAlbums().filter(a => a.id !== currentAlbumId);
    if (albums.length === 0) return null;

    return `
        <div id="moveDialogOverlay" style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:200; display:flex; align-items:center; justify-content:center;">
            <div style="background:white; border-radius:20px; padding:20px; width:280px; max-height:60%; overflow-y:auto;">
                <div style="font-weight:600; font-size:16px; margin-bottom:12px;">移动到哪个相册？</div>
                ${albums.map(a => `
                    <div class="move-target" data-album="${a.id}" style="padding:10px 14px; border-radius:12px; cursor:pointer; margin-bottom:6px; background:#f5f5f5; font-size:14px;">
                        ${a.type === 'preset' ? (a.id === 'album_avatar' ? '👤' : '🖼️') : '📁'} ${a.name} (${a.images.length} 张)
                    </div>
                `).join('')}
                <div id="cancelMoveBtn" style="padding:10px 14px; border-radius:12px; cursor:pointer; text-align:center; margin-top:6px; color:#888; font-size:14px;">取消</div>
            </div>
        </div>
    `;
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    // 列表页
    if (viewingAlbum === null) {
        container.querySelectorAll('.album-item[data-album]').forEach(item => {
            item.addEventListener('click', () => {
                viewingAlbum = item.dataset.album;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render();
                bindEvents(appContainer);
            });
        });

        // 新建相册
        container.querySelector('#addAlbumBtn')?.addEventListener('click', async () => {
            const name = await showPrompt('请输入相册名称：');
            if (!name || !name.trim()) return;
            const albums = getAlbums();
            albums.push({ id: generateAlbumId(), name: name.trim(), type: 'custom', images: [] });
            saveAlbums(albums);
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });
        return;
    }

    // 子页面
    const albums = getAlbums();
    const album = albums.find(a => a.id === viewingAlbum);
    if (!album) { viewingAlbum = null; return; }

    // 添加图片到自定义相册
    container.querySelector('#addToAlbumBtn')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const key = 'gallery_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
                setGlobalImage(key, ev.target.result);

                const albums = getAlbums();
                const album = albums.find(a => a.id === viewingAlbum);
                if (album) {
                    album.images.push(key);
                    saveAlbums(albums);
                }
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render();
                bindEvents(appContainer);
            };
            reader.readAsDataURL(file);
        };
        input.click();
    });

    // 移动图片
    container.querySelectorAll('.move-img-btn').forEach(btn => {
        btn.addEventListener('click', async function () {
            const key = this.dataset.key;
            const currentAlbumId = this.dataset.album;

            const dialogHtml = renderMoveDialog(currentAlbumId);
            if (!dialogHtml) { alert('没有其他相册可以移动'); return; }

            const dialogEl = document.createElement('div');
            dialogEl.innerHTML = dialogHtml;
            document.body.appendChild(dialogEl);

            dialogEl.querySelectorAll('.move-target').forEach(target => {
                target.addEventListener('click', function () {
                    const targetAlbumId = this.dataset.album;
                    const albums = getAlbums();
                    const srcAlbum = albums.find(a => a.id === currentAlbumId);
                    const dstAlbum = albums.find(a => a.id === targetAlbumId);
                    if (srcAlbum && dstAlbum) {
                        srcAlbum.images = srcAlbum.images.filter(k => k !== key);
                        dstAlbum.images.push(key);
                        saveAlbums(albums);
                    }
                    dialogEl.remove();
                    const appContainer = container.closest('.screen-page') || container;
                    appContainer.innerHTML = render();
                    bindEvents(appContainer);
                });
            });

            dialogEl.querySelector('#cancelMoveBtn')?.addEventListener('click', () => {
                dialogEl.remove();
            });
        });
    });

    // 从相册移除 → 改为移到回收站
    container.querySelectorAll('.del-from-album-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const key = this.dataset.key;
            const currentAlbumId = this.dataset.album;

            // 如果已经是在回收站里，不允许再次"移到回收站"
            if (currentAlbumId === 'album_trash') return;

            const albums = getAlbums();
            const srcAlbum = albums.find(a => a.id === currentAlbumId);
            const trashAlbum = albums.find(a => a.id === 'album_trash');

            if (srcAlbum && trashAlbum) {
                // 从原相册移除
                srcAlbum.images = srcAlbum.images.filter(k => k !== key);
                // 移到回收站（避免重复）
                if (!trashAlbum.images.includes(key)) {
                    trashAlbum.images.push(key);
                }
                saveAlbums(albums);
            }

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });
    });

    // ★ 彻底删除（回收站专用）
    container.querySelectorAll('.permanent-delete-btn').forEach(btn => {
        btn.addEventListener('click', async function () {
            const key = this.dataset.key;
            const ok = await showConfirm('确定要彻底删除这张图片吗？如果是角色头像或形象卡，删除后只能重新上传。');
            if (!ok) return;
            // 从回收站相册移除
            const albums = getAlbums();
            const trashAlbum = albums.find(a => a.id === 'album_trash');
            if (trashAlbum) {
                trashAlbum.images = trashAlbum.images.filter(k => k !== key);
                saveAlbums(albums);
            }

            // ★ 调 ImageCache 彻底删除图片数据
            removeImage(key);

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });
    });

    // ★ 点击图片大图预览
    container.querySelectorAll('[data-key] img').forEach(img => {
        img.addEventListener('click', function (e) {
            // 如果点的是按钮，忽略
            if (e.target.closest('button')) return;
            const key = this.closest('[data-key]')?.dataset.key;
            if (key) showImagePreview(key);
        });
    });


    // ★ 下载图片
    container.querySelectorAll('.download-img-btn').forEach(btn => {
        btn.addEventListener('click', async function () {   // ← 加 async
            const key = this.dataset.key;
            const dataUrl = await getImageDataUrl(key);      // ← 加 await

            if (!dataUrl) { alert('无法获取图片数据'); return; }

            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = key.replace(/[^a-zA-Z0-9]/g, '_') + '.png';
            a.click();
        });
    });
    // ★ 设为桌宠
    container.querySelectorAll('.set-pet-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const key = this.dataset.key;
            localStorage.setItem('pet_active_sprite', key);
            // 视觉反馈
            this.textContent = '✅ 已设为桌宠';
            this.style.background = 'rgba(46,125,50,0.85)';
            setTimeout(() => {
                this.textContent = '🐱 设为桌宠';
                this.style.background = 'rgba(255,152,0,0.85)';
            }, 2000);
        });
    });


}

// ---- 返回处理 ----
export function handleBack(container) {
    if (viewingAlbum !== null) {
        viewingAlbum = null;
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = render();
        bindEvents(appContainer);
        return true;
    }
    return false;
}

// ---- 相册选择器（供其他模块调用）----
/**
 * 弹出相册选择器弹窗，选择一个图片后回调
 * @param {function} onSelect - 回调函数，接收 galleryKey 参数
 */
export function renderGalleryPicker(onSelect) {
    const albums = getAlbums();
    // 收集所有相册的所有图片（去重）
    const imageMap = new Map();
    albums.forEach(album => {
        if (album.id === 'album_trash') return; // 跳过回收站
        album.images.forEach(key => {
            if (!imageMap.has(key)) {
                imageMap.set(key, { key, albumName: album.name });
            }
        });
    });
    const allImages = Array.from(imageMap.values());

    if (allImages.length === 0) {
        alert('相册里还没有图片，请先在相册中添加');
        return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.6); z-index:300; display:flex; align-items:center; justify-content:center;';

    overlay.innerHTML = `
        <div style="background:white; border-radius:20px; padding:16px; width:300px; max-height:70%; overflow-y:auto;">
            <div style="font-weight:600; font-size:16px; margin-bottom:12px;">从相册选择图片</div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px;">
                ${allImages.map(img => `
                    <div class="gallery-picker-item" data-key="${img.key}"
                         style="border-radius:8px; overflow:hidden; aspect-ratio:1; background:#f0f0f0;
                                cursor:pointer; border:2px solid transparent;">
                        ${renderImageByKey(img.key)}
                    </div>
                `).join('')}
            </div>
            <div id="cancelPickerBtn" style="padding:10px 14px; text-align:center; margin-top:8px; color:#888; cursor:pointer; font-size:14px;">取消</div>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelectorAll('.gallery-picker-item').forEach(item => {
        item.addEventListener('click', () => {
            const key = item.dataset.key;
            overlay.remove();
            onSelect(key);
        });
    });

    overlay.querySelector('#cancelPickerBtn')?.addEventListener('click', () => {
        overlay.remove();
    });
}


if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });
