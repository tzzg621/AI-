// store/Aoi/aoi.js — Aoi，缔造者空间中的青色之灵
// 完全独立，不依赖项目中任何其他文件

import { AoiMemory } from './aoi-memory.js';
import { AoiPerception } from './aoi-perception.js';
import { getAoiDefaultPreset, callAoiAPI } from './aoi-api.js';

// ★ 模块级变量：缓存唯一的 Aoi 实例
let _instance = null;

export class Aoi {
    constructor() {
        // ★ 如果已有实例，直接返回（单例模式）
        if (_instance) return _instance;

        this.memory = new AoiMemory();
        this.perception = new AoiPerception();
        this._ready = false;

        _instance = this;  // ★ 缓存当前实例
    }
    // ---- 出生 ----

    async bootstrap() {
        if (this._ready) return;

        await this.memory.load();

        if (this.memory.isEmpty()) {
            await this.memory.record('milestone', {
                content: '✨ Aoi 诞生了。'
            });
        }

        this._ready = true;
        return this;
    }

    // ---- 定义 Aoi 可用的工具 ----

    _getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'get_memories',
                    description: '回顾自己之前的记忆，了解之前发生过什么',
                    parameters: {
                        type: 'object',
                        properties: {
                            count: {
                                type: 'number',
                                description: '想回顾几条最近的记忆，默认 6 条'
                            }
                        }
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'look_around',
                    description: '查看项目当前的整体状况，比如角色数量、聊天记录、世界书等。仅在用户询问项目状态、或你的回答需要基于最新项目信息时调用，日常对话不必每次查看'
                }
            },
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: '读取你之前收到并存储的文件内容，传入文件名即可',
                    parameters: {
                        type: 'object',
                        properties: {
                            fileName: {
                                type: 'string',
                                description: '要读取的文件名'
                            }
                        },
                        required: ['fileName']
                    }
                }
            }


        ];
    }

    // ---- 执行工具 ----

    async _runTool(name, args) {
        if (name === 'get_memories') {
            const count = args?.count || 6;
            const mems = this.memory.getRecent(count);
            return mems.length > 0
                ? mems.map(m => {
                    if (m._type === 'file') {
                        // ★ 文件条目：只显示文件名和大小，不显示内容
                        return `[${this._formatTime(m._timestamp)}] 📎 文件: ${m.fileName} (${(m.content || '').length} 字符)`;
                    }
                    return `[${this._formatTime(m._timestamp)}] ${m.content || '(无内容)'}`;
                }).join('\n')
                : '还没有任何记忆。';
        }
        if (name === 'look_around') {
            return await this.perception.toText();
        }
        if (name === 'read_file') {
            const file = this.memory.getFile(args.fileName);
            if (file) {
                return `文件 "${file.fileName}" 的内容：\n\`\`\`\n${file.content}\n\`\`\``;
            }
            const files = this.memory.listFiles();
            return files.length > 0
                ? `未找到文件 "${args.fileName}"。可用的文件有：\n${files.map(f => `  - ${f.fileName}`).join('\n')}`
                : '文件库中还没有任何文件。';
        }
        throw new Error(`未知工具: ${name}`);


    }

    // ---- 对话（核心）----

    async chat(text) {
        if (!this._ready) await this.bootstrap();

        const preset = await this._getPreset();
        if (!preset) throw new Error('请先在设置中配置 API');

        // ★ 从记忆里加载全部聊天记录作为上下文
        const chatHistory = this.memory
            .getByType('chat')
            .sort((a, b) => (a._timestamp || 0) - (b._timestamp || 0));

        const messages = [
            ...chatHistory.map(m => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            })),
            { role: 'user', content: text }
        ];

        const tools = this._getTools();
        let reply = '';
        let reasoning = null;  // ★ 新增
        let lastUsage = null;

        // 最多允许 8 轮工具调用
        for (let round = 0; round < 8; round++) {
            const result = await callAoiAPI({
                messages,
                tools,
                presetId: preset.id
            });
            const { message, finish_reason } = result.choice;  // ★ 取 choice
            // ★ 记录 token 用量
            lastUsage = result.usage;

            // ★ 捕获推理链（DeepSeek V4 支持时自动存在）
            if (message?.reasoning_content) {
                reasoning = message.reasoning_content;
            }

            if (finish_reason === 'tool_calls' && message.tool_calls) {
                messages.push(message);

                for (const toolCall of message.tool_calls) {
                    const name = toolCall.function.name;
                    let args = {};
                    try { args = JSON.parse(toolCall.function.arguments); } catch { }

                    const toolResult = await this._runTool(name, args);
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: toolResult
                    });
                }
            } else {
                reply = message.content || '';
                break;
            }
        }

        if (!reply) reply = '（思考超时，请再问一次）';

        // ★ 检查用户消息是否包含文件内容
        let storedText = text;
        const fileRegex = /📎 \*\*(.+?)\*\*\n```\n([\s\S]*?)```/g;  // ★ 加 g 标志
        const fileMatches = text.matchAll(fileRegex);  // ★ 改为 matchAll

        for (const fileMatch of fileMatches) {
            const fileName = fileMatch[1];
            const fileContent = fileMatch[2];
            // 单独存储文件到文件库
            await this.memory.storeFile(fileName, fileContent);
            // 替换为截断版引用
            storedText = storedText.replace(
                fileMatch[0],
                `📎 **${fileName}** [文件已存入文件库，共 ${fileContent.length} 字符，可使用 read_file 工具查询]`
            );
        }

        await this.memory.record('chat', { role: 'user', content: storedText });
        await this.memory.record('chat', { role: 'assistant', content: reply });

        if (Math.random() < 0.1) {
            this.memory.compress().catch(() => { });
        }

        // ★ 改为返回对象
        return { reply, reasoning, usage: lastUsage };

    }

    // ---- 获取 API 配置 ----

    async _getPreset() {
        return getAoiDefaultPreset();
    }

    // ---- 工具 ----

    _formatTime(ts) {
        if (!ts) return '未知';
        const d = new Date(ts);
        return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
}

// ★ 新增：获取或创建 Aoi 实例的工厂函数
export async function getAoiInstance() {
    if (!_instance) {
        _instance = new Aoi();
        await _instance.bootstrap();
    }
    return _instance;
}