// store/CardFileIO.js — 角色卡文件 IO（零外部依赖）
// PNG tEXt（chara 标准）/ JPG 尾部附加（自家格式）/ docx 文本提取
// 供生成器（导入）与画廊（导出）共用

// ============================================================
//  CRC32（PNG chunk 校验）
// ============================================================
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================
//  JSON ⇄ base64（Unicode 安全）
// ============================================================
function jsonToBase64(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin);
}
function base64ToJson(b64) {
    const bin = atob(b64.trim());
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

// ============================================================
//  PNG：解析嵌入式数据（chara / rolecard tEXt 块）
//  成功返回解析后的 JSON；失败抛"文件格式不正确，提取失败"
// ============================================================
export async function parsePngEmbedded(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);

    // ① 验 PNG 签名
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== sig[i]) throw new Error('文件格式不正确，提取失败');
    }

    // ② 遍历 chunks 找 tEXt / iTXt
    const decoder = new TextDecoder();
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
        const dataStart = offset + 8;
        if (type === 'IEND') break;

        if (type === 'tEXt' || type === 'iTXt') {
            const data = bytes.slice(dataStart, dataStart + len);
            const nulIdx = data.indexOf(0);
            if (nulIdx > 0) {
                const keyword = decoder.decode(data.slice(0, nulIdx));
                if (keyword === 'chara' || keyword === 'rolecard') {
                    // ★ iTXt 需要跳过: compressionFlag(1) + compressionMethod(1) + langTag\0 + translatedKeyword\0
                    let value;
                    if (type === 'iTXt') {
                        const compressionFlag = data[nulIdx + 1];       // ★ 读取压缩标志
                        let idx = nulIdx + 1 + 2;                       // keyword\0 + flag/method
                        const ltEnd = data.indexOf(0, idx);             // languageTag\0 结束
                        if (ltEnd === -1) throw new Error('文件格式不正确，提取失败');
                        idx = data.indexOf(0, ltEnd + 1);               // translatedKeyword\0 结束
                        if (idx === -1) throw new Error('文件格式不正确，提取失败');
                        const textBytes = data.slice(idx + 1);
                        if (compressionFlag === 1) {
                            // ★ zlib 解压（PNG 用 'deflate'，不是 docx 的 'deflate-raw'）
                            const ds = new DecompressionStream('deflate');
                            const stream = new Blob([textBytes]).stream().pipeThrough(ds);
                            const decompressed = await new Response(stream).arrayBuffer();
                            value = decoder.decode(decompressed);
                        } else {
                            value = decoder.decode(textBytes);
                        }
                    } else {
                        value = decoder.decode(data.slice(nulIdx + 1));
                    }
                    try {
                        const jsonStr = atob(value.trim());
                        return JSON.parse(jsonStr);
                    } catch {
                        try {
                            return JSON.parse(value.trim());
                        } catch {
                            throw new Error('文件格式不正确，提取失败');
                        }
                    }
                }
            }
        }
        offset = dataStart + len + 4; // data + CRC
    }
    throw new Error('文件格式不正确，提取失败');
}

// ============================================================
//  PNG：在 IEND 前插入 tEXt 块（chara 标准，导出用）
//  pngBlob: canvas 生成的 PNG；返回带数据的新 Blob
// ============================================================
export async function buildPngWithText(pngBlob, keyword, obj) {
    const bytes = new Uint8Array(await pngBlob.arrayBuffer());

    // 解析原 chunks
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + len) });
        offset += 12 + len;
        if (type === 'IEND') break;
    }

    // 构造 tEXt chunk 数据：keyword\0text（text 为 base64 ASCII，兼容 tEXt 的 latin1）
    const value = jsonToBase64(obj);
    const kw = new TextEncoder().encode(keyword);
    const tv = new TextEncoder().encode(value);
    const data = new Uint8Array(kw.length + 1 + tv.length);
    data.set(kw);
    data[kw.length] = 0;
    data.set(tv, kw.length + 1);

    const typeBytes = new TextEncoder().encode('tEXt');
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes);
    crcInput.set(data, 4);
    const crc = crc32(crcInput);

    // 重建：签名 + 非 IEND chunks + tEXt + IEND
    const out = [];
    out.push(...bytes.slice(0, 8));
    for (const c of chunks) {
        if (c.type === 'IEND') continue;
        const lenB = new Uint8Array(4);
        new DataView(lenB.buffer).setUint32(0, c.data.length);
        out.push(...lenB);
        out.push(...new TextEncoder().encode(c.type));
        out.push(...c.data);
        const crcIn = new Uint8Array(4 + c.data.length);
        crcIn.set(new TextEncoder().encode(c.type));
        crcIn.set(c.data, 4);
        const crcB = new Uint8Array(4);
        new DataView(crcB.buffer).setUint32(0, crc32(crcIn));
        out.push(...crcB);
    }
    // tEXt
    const lenB = new Uint8Array(4);
    new DataView(lenB.buffer).setUint32(0, data.length);
    out.push(...lenB);
    out.push(...typeBytes);
    out.push(...data);
    const crcB = new Uint8Array(4);
    new DataView(crcB.buffer).setUint32(0, crc);
    out.push(...crcB);
    // IEND
    out.push(...[0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

    return new Blob([new Uint8Array(out)], { type: 'image/png' });
}

// ============================================================
//  JPG：解析尾部附加数据（自家格式 <!--RCARD_DATA:base64-->）
//  失败抛"文件格式不正确，提取失败"
// ============================================================
export async function parseJpgEmbedded(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);

    // 验 JPG 签名 FFD8FF
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) {
        throw new Error('文件格式不正确，提取失败');
    }

    const text = new TextDecoder().decode(bytes);
    const marker = '<!--RCARD_DATA:';
    const idx = text.indexOf(marker);
    if (idx === -1) throw new Error('文件格式不正确，提取失败');
    const endIdx = text.indexOf('-->', idx);
    if (endIdx === -1) throw new Error('文件格式不正确，提取失败');

    const b64 = text.substring(idx + marker.length, endIdx).trim();
    return base64ToJson(b64);
}

// ============================================================
//  JPG：写入尾部附加数据（导出用）
//  jpgBlob: canvas 生成的 JPG；返回带数据的新 Blob
// ============================================================
export async function buildJpgWithData(jpgBlob, obj) {
    const bytes = new Uint8Array(await jpgBlob.arrayBuffer());
    const marker = '<!--RCARD_DATA:';
    const tail = new TextEncoder().encode(marker + jsonToBase64(obj) + '-->');
    const out = new Uint8Array(bytes.length + tail.length);
    out.set(bytes);
    out.set(tail, bytes.length);
    return new Blob([out], { type: 'image/jpeg' });
}

// ============================================================
//  docx：提取正文纯文本（zip 解析 + DecompressionStream，零依赖）
//  返回提取的文本；失败抛"文件格式不正确，提取失败"
// ============================================================
export async function parseDocxText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('utf-8');

    // ① 遍历 local file headers（PK\x03\x04），找 word/document.xml
    const entries = [];
    let offset = 0;
    while (offset + 30 <= bytes.length) {
        if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4B) break;
        const sig = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (sig !== 0x0403) break;   // local file header

        const compMethod = (bytes[offset + 8] << 8) | bytes[offset + 9];
        const compSize = (bytes[offset + 18] << 24) | (bytes[offset + 19] << 16) | (bytes[offset + 20] << 8) | bytes[offset + 21];
        const nameLen = (bytes[offset + 26] << 8) | bytes[offset + 27];
        const extraLen = (bytes[offset + 28] << 8) | bytes[offset + 29];
        const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLen));
        const dataStart = offset + 30 + nameLen + extraLen;

        entries.push({ name, compMethod, compSize, dataStart });
        offset = dataStart + compSize;
    }

    const doc = entries.find(e => e.name === 'word/document.xml');
    if (!doc) throw new Error('文件格式不正确，提取失败');

    // ② 解压（0=stored，8=deflate）
    let xml;
    const compressed = bytes.slice(doc.dataStart, doc.dataStart + doc.compSize);
    if (doc.compMethod === 0) {
        xml = decoder.decode(compressed);
    } else if (doc.compMethod === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([compressed]).stream().pipeThrough(ds);
        xml = decoder.decode(await new Response(stream).arrayBuffer());
    } else {
        throw new Error('文件格式不正确，提取失败');
    }

    // ③ 提取段落文本（<w:p> 分段，<w:t> 取文本）
    const paragraphs = [];
    const pRegex = /<w:p[\s\S]*?<\/w:p>/g;
    let pm;
    while ((pm = pRegex.exec(xml)) !== null) {
        const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
        let tm, line = '';
        while ((tm = tRegex.exec(pm[0])) !== null) line += tm[1];
        paragraphs.push(line);
    }

    // ④ XML 实体解码
    const decodeXml = s => s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

    const text = paragraphs.map(decodeXml).filter(l => l.trim()).join('\n');
    if (!text.trim()) throw new Error('文件格式不正确，提取失败');
    return text;
}

// ============================================================
//  PNG：剥离附加数据（只删 chara/rolecard 文本块，像素无损）
// ============================================================
export async function stripPngData(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder();

    // 解析所有 chunks
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const data = bytes.slice(offset + 8, offset + 8 + len);
        chunks.push({ type, data });
        offset += 12 + len;
        if (type === 'IEND') break;
    }

    // 重建：跳过 chara/rolecard 文本块，其余原样保留（含 CRC 重算）
    const out = [];
    out.push(...bytes.slice(0, 8));
    for (const c of chunks) {
        // 只剥离指定 keyword 的文本块，其他文本块（软件信息等）保留
        if (c.type === 'tEXt' || c.type === 'iTXt') {
            const nulIdx = c.data.indexOf(0);
            if (nulIdx > 0) {
                const kw = decoder.decode(c.data.slice(0, nulIdx));
                if (kw === 'chara' || kw === 'rolecard') continue;
            }
        }
        const lenB = new Uint8Array(4);
        new DataView(lenB.buffer).setUint32(0, c.data.length);
        out.push(...lenB);
        out.push(...new TextEncoder().encode(c.type));
        out.push(...c.data);
        const crcIn = new Uint8Array(4 + c.data.length);
        crcIn.set(new TextEncoder().encode(c.type));
        crcIn.set(c.data, 4);
        const crcB = new Uint8Array(4);
        new DataView(crcB.buffer).setUint32(0, crc32(crcIn));
        out.push(...crcB);
    }
    return new Blob([new Uint8Array(out)], { type: 'image/png' });
}

// ============================================================
//  JPG：剥离尾部附加数据（截到 FFD9 EOI 标记，像素无损）
// ============================================================
export async function stripJpgData(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // 第一个 FFD9 就是 EOI，尾部数据都在它之后
    let end = bytes.length;
    for (let i = 0; i < bytes.length - 1; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD9) {
            end = i + 2;
            break;
        }
    }
    return new Blob([bytes.slice(0, end)], { type: 'image/jpeg' });
}
