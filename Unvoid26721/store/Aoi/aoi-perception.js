// store/Aoi/aoi-perception.js — Aoi 的感知模块
// 只读窥视外界，从不写入

export class AoiPerception {
    constructor() {
        this._cache = null;
        this._cacheTime = 0;
    }

    // ---- 看一眼世界 ----

    async look() {
        const snapshot = {
            time: new Date().toLocaleString('zh-CN'),
            characters: this._getCharacters(),
            activeCharacter: this._getActiveCharacter(),
            worldEntries: this._getWorldEntries(),
            memoryCount: this._getMemoryCount(),
            chatCount: this._getChatCount(),
            galleryCount: this._getGalleryCount(),
            novels: this._getNovels()
        };
        return snapshot;
    }

    // ---- 只读读取器们（只从 localStorage 读，从不写）----

    _getCharacters() {
        try {
            const data = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
            return data.map(c => ({
                name: c.base?.name || '未知',
                emoji: c.base?.emoji || '👤',
                desc: c.base?.desc || '',
                type: c.type || 'normal'
            }));
        } catch { return []; }
    }

    _getActiveCharacter() {
        try {
            const chars = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
            const idx = parseInt(localStorage.getItem('rolebook_activeIndex') || '-1');
            if (idx >= 0 && idx < chars.length) {
                return chars[idx].base?.name || '未知';
            }
        } catch { }
        return '未选择';
    }

    _getWorldEntries() {
        try {
            const entries = JSON.parse(localStorage.getItem('worldbook_entries') || '[]');
            return entries
                .filter(e => e.enabled !== false)
                .map(e => ({ title: e.title || '无标题' }));
        } catch { return []; }
    }

    _getMemoryCount() {
        let count = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            // CharacterStore 的 key 格式是 'char_{id}'，记忆在 data.memories 里
            if (key && key.startsWith('char_') && !key.startsWith('char__')) {
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    if (data.memories && Array.isArray(data.memories)) {
                        count += data.memories.length;
                    }
                } catch { }
            }
        }
        return count;
    }

    _getChatCount() {
        let count = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            // 同样查找 'char_{id}'，聊天消息在 data.chatMessages 里
            if (key && key.startsWith('char_') && !key.startsWith('char__')) {
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    if (data.chatMessages) {
                        Object.values(data.chatMessages).forEach(msgs => {
                            count += msgs.length;
                        });
                    }
                } catch { }
            }
        }
        return count;
    }

    _getGalleryCount() {
        try {
            const albums = JSON.parse(localStorage.getItem('gallery_albums') || '[]');
            return albums.reduce((sum, a) => sum + (a.images?.length || 0), 0);
        } catch { return 0; }
    }

    _getNovels() {
        try {
            const novels = JSON.parse(localStorage.getItem('bookclub_novels') || '[]');
            return novels.map(n => ({
                title: n.title || '无题',
                chapterCount: (n.chapters || []).length
            }));
        } catch { return []; }
    }

    // ---- 生成文本摘要（给 Aoi 看）----

    async toText() {
        const s = await this.look();
        let text = `现在时间是 ${s.time}。（以下是你观察到的外部数据摘要，与你自己的记忆无关）`;

        if (s.characters.length > 0) {
            text += `\n项目中有 ${s.characters.length} 个角色：`;
            s.characters.forEach(c => {
                text += `\n  ${c.emoji} ${c.name} — ${c.desc || '暂无描述'}`;
            });
            text += `\n当前用户选择的主视角：${s.activeCharacter}`;
        }

        if (s.worldEntries.length > 0) {
            text += `\n世界书中有 ${s.worldEntries.length} 条已启用的设定。`;
        }

        text += `\n项目中共有约 ${s.memoryCount} 条角色记忆、${s.chatCount} 条聊天记录、${s.galleryCount} 张图片。`;

        if (s.novels.length > 0) {
            text += `\n正在创作的小说：`;
            s.novels.forEach(n => {
                text += `\n  📖 ${n.title}（${n.chapterCount} 章）`;
            });
        }

        return text;
    }
}
