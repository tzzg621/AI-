// store/CharacterStore.js
// ★ 这个类负责管理单个角色的所有数据（好友、聊天、记忆）

const STORAGE_PREFIX = 'char_';  // 所有角色数据以 char_ 开头存储

export class CharacterStore {
    // constructor 是"构造函数"——当你 new CharacterStore('farmer') 时自动调用
    constructor(characterId) {
        this.id = characterId;
        this.storageKey = STORAGE_PREFIX + characterId;  // 例如: 'char_farmer'
        this.data = this._load();
    }

    // ---- 私有方法（以 _ 开头，表示"不要直接调用"）----
    _load() {
        const saved = localStorage.getItem(this.storageKey);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                // 确保必要的字段存在（兼容旧数据）
                if (!parsed.friends) parsed.friends = {};
                if (!parsed.chatMessages) parsed.chatMessages = {};
                if (!parsed.memories) parsed.memories = [];
                if (!parsed.info) parsed.info = {};
                return parsed;
            } catch (e) {
                console.warn(`角色 ${this.id} 数据损坏，已重置`);
            }
        }
        // 默认数据结构
        return {
            id: this.id,       // ← 用 this.id
            info: {},         // ★ 新增：存储名称、头像等显示信息
            friends: {},
            chatMessages: {},
            memories: []
        };
    }

    // ★ 新增：设置角色显示信息
    setInfo(info) {
        this.data.info = { ...this.data.info, ...info };
        this._save();
    }

    // ★ 新增：获取角色显示信息
    getInfo() {
        return this.data.info || {};
    }

    _save() {
        localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    }

    // ---- 好友操作 ----
    addFriend(friendId) {
        if (this.data.friends[friendId]) return false; // 已经是好友
        this.data.friends[friendId] = true;
        this._save();
        return true;
    }

    removeFriend(friendId) {
        if (!this.data.friends[friendId]) return false;
        delete this.data.friends[friendId];
        this._save();
        return true;
    }

    isFriend(friendId) {
        return !!this.data.friends[friendId];
    }

    getFriendIds() {
        return Object.keys(this.data.friends);
    }

    // ---- 聊天操作 ----
    addMessage(pairKey, message) {
        if (!this.data.chatMessages[pairKey]) {
            this.data.chatMessages[pairKey] = [];
        }
        this.data.chatMessages[pairKey].push(message);
        this._save();
    }

    getMessages(pairKey) {
        return this.data.chatMessages[pairKey] || [];
    }

    getAllPairKeys() {
        return Object.keys(this.data.chatMessages);
    }

    // ---- 记忆操作 ----
    addMemory(memory) {
        this.data.memories.push(memory);
        this._save();
    }

    getMemories() {
        return this.data.memories;
    }

    // ---- 获取完整的角色数据（给其他模块用） ----
    getFullData() {
        return { ...this.data };
    }
}

// ---- 双向好友操作 ----
export function addBidirectionalFriend(id1, id2) {
    const store1 = new CharacterStore(id1);
    const store2 = new CharacterStore(id2);
    const added1 = store1.addFriend(id2);
    const added2 = store2.addFriend(id1);
    return added1 || added2;
}


// ---- 全局工具函数 ----
export function generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 5);
    return `char_${timestamp}_${random}`;
}

// ---- 统一角色数据结构模板 ----
export function createDefaultCharacterData(id, baseInfo, type = 'npc', flags = {}) {
    return {
        id: id,
        base: {
            name: baseInfo.name || '未知角色',
            emoji: baseInfo.emoji || '❓',
            desc: baseInfo.desc || '',
            stats: baseInfo.stats || { 力量: 50, 智力: 50, 魅力: 50 },
            secret: baseInfo.secret || '',
            style: baseInfo.style || '',
            memories: baseInfo.memories || []
        },
        type: type,  // 'npc' | 'character' | 'special'
        flags: {
            convertible: flags.convertible !== undefined ? flags.convertible : true,
            switchable: flags.switchable !== undefined ? flags.switchable : false,
            customizable: flags.customizable !== undefined ? flags.customizable : false
        },
        extended: {
            backstory: flags.backstory || '',
            skills: flags.skills || '',
            relations: flags.relations || ''
        }
    };
}

// ---- 全局工具函数：获取当前主视角角色的 ID ----
export function getActiveCharacterId(globalState) {
    const char = globalState?.activeCharacter;
    return char?.id || char?.base?.name || 'unknown';
}
