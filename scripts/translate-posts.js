/**
 * Hexo 构建时翻译脚本
 * ============================================================
 * 在 hexo generate 时自动翻译所有英文文章，生成翻译 JSON 到 public/translations/
 * 前端直接读取预翻译的 JSON，不消耗运行时 API 额度
 *
 * 配置（在 _config.yml 中添加）：
 *   translate:
 *     deepl_api_key: 'your-key-here'
 *     target_lang: 'ZH'
 *
 * 只翻译非中文文章（检测中文占比 < 30%）
 * 翻译粒度：按段落/标题独立翻译，保留原始 HTML 标签结构
 * ============================================================ */

var fs = require('fs');
var path = require('path');
var https = require('https');

var CONFIG = {
  api_key: '',
  target_lang: 'ZH',
  api_url: 'https://api-free.deepl.com/v2/translate',
  batch_size: 50,
  delay_ms: 1000
};

// ========== 语言检测 ==========
function isMainlyChinese(text) {
  var clean = text.replace(/[\s\d.,;:?\-()[\]{}]/g, '');
  if (clean.length === 0) return true;
  var chinese = 0;
  for (var i = 0; i < clean.length; i++) {
    if (/[\u4e00-\u9fff]/.test(clean[i])) chinese++;
  }
  return chinese / clean.length > 0.3;
}

// ========== DeepL API ==========
function translateBatch(texts, sourceLang) {
  return new Promise(function(resolve, reject) {
    if (!CONFIG.api_key) {
      reject(new Error('No DeepL API key'));
      return;
    }
    if (texts.length === 0) {
      resolve([]);
      return;
    }

    var body = JSON.stringify({
      text: texts,
      source_lang: sourceLang || 'EN',
      target_lang: CONFIG.target_lang,
      tag_handling: 'html',
      preserve_formatting: true
    });

    var url = new URL(CONFIG.api_url);
    var options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'DeepL-Auth-Key ' + CONFIG.api_key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.translations) {
            resolve(json.translations.map(function(t) { return t.text; }));
          } else {
            reject(new Error('Unexpected response: ' + data.substring(0, 200)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, function() { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ========== HTML 结构保留翻译 ==========
// 提取文本段（跳过 <code>, <pre>, <script>, <style>, <svg>）
function extractTextSegments(html) {
  var segments = [];
  // 匹配标签外的纯文本
  var parts = html.split(/(<[^>]+>)/);
  var skip = false;

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part) continue;

    if (part.match(/^<(code|pre|script|style|svg|math)/i)) {
      skip = true;
      continue;
    }
    if (part.match(/^<\/(code|pre|script|style|svg|math)/i)) {
      skip = false;
      continue;
    }
    if (skip) continue;
    if (part.match(/^<[^>]+>$/)) continue; // 是标签，跳过

    // 纯文本
    var trimmed = part.trim();
    if (trimmed.length > 1 && !/^[\s\d.,;:?\-()]+$/.test(trimmed)) {
      segments.push({
        original: trimmed,
        placeholder: '%%SEG_' + segments.length + '%%'
      });
    }
  }

  return segments;
}

// 用占位符替换原文，翻译后再替换回来
function translateContent(html, segments, translations) {
  var result = html;
  for (var i = 0; i < segments.length; i++) {
    result = result.replace(segments[i].original, segments[i].placeholder);
  }
  for (var j = 0; j < segments.length; j++) {
    if (translations[j]) {
      result = result.replace(segments[j].placeholder, translations[j]);
    } else {
      result = result.replace(segments[j].placeholder, segments[j].original);
    }
  }
  return result;
}

// ========== 延迟 ==========
function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ========== Hexo 插件入口 ==========
module.exports = function(hexo) {
  // 读取配置
  var userConfig = hexo.config.translate || {};
  CONFIG.api_key = userConfig.deepl_api_key || '';
  CONFIG.target_lang = userConfig.target_lang || 'ZH';

  if (!CONFIG.api_key) {
    console.log('[translate] No DeepL API key configured. Add to _config.yml:');
    console.log('[translate]   translate:');
    console.log('[translate]     deepl_api_key: "your-key-here"');
    return;
  }

  // 注册 after_generate 钩子
  hexo.extend.filter.register('after_generate', function() {
    var posts = hexo.locals.get('posts');
    if (!posts || posts.length === 0) return;

    var transDir = path.join(hexo.public_dir, 'translations');
    if (!fs.existsSync(transDir)) {
      fs.mkdirSync(transDir, { recursive: true });
    }

    console.log('[translate] Starting build-time translation for ' + posts.length + ' posts...');

    var processed = 0;
    var skipped = 0;
    var translated = 0;

    return posts.reduce(function(chain, post) {
      return chain.then(function() {
        var slug = post.slug;
        var content = post.content;
        var title = post.title || slug;

        // 跳过中文文章
        if (isMainlyChinese(content)) {
          skipped++;
          return Promise.resolve();
        }

        // 检查缓存
        var transFile = path.join(transDir, slug + '.json');
        if (fs.existsSync(transFile)) {
          processed++;
          return Promise.resolve();
        }

        console.log('[translate] Translating: ' + title);

        // 提取文本段
        var segments = extractTextSegments(content);
        if (segments.length === 0) {
          skipped++;
          return Promise.resolve();
        }

        // 提取纯文本
        var texts = segments.map(function(s) { return s.original; });

        // 分批翻译
        var batches = [];
        for (var i = 0; i < texts.length; i += CONFIG.batch_size) {
          batches.push(texts.slice(i, i + CONFIG.batch_size));
        }

        var allTranslations = [];
        var batchChain = Promise.resolve();

        batches.forEach(function(batch, idx) {
          batchChain = batchChain.then(function() {
            return translateBatch(batch, 'EN').then(function(result) {
              allTranslations = allTranslations.concat(result);
              if (idx < batches.length - 1) {
                return delay(CONFIG.delay_ms);
              }
            });
          });
        });

        return batchChain.then(function() {
          // 生成翻译后的 HTML
          var translatedHTML = translateContent(content, segments, allTranslations);

          // 保存翻译数据
          var data = {
            slug: slug,
            title: title,
            sourceLang: 'EN',
            targetLang: CONFIG.target_lang,
            timestamp: Date.now(),
            originalHTML: content,
            translatedHTML: translatedHTML,
            segments: {}
          };

          // 建立原文→译文映射
          for (var k = 0; k < segments.length; k++) {
            if (allTranslations[k]) {
              data.segments[segments[k].original] = allTranslations[k];
            }
          }

          fs.writeFileSync(transFile, JSON.stringify(data, null, 2), 'utf8');
          translated++;
          console.log('[translate] Saved: ' + slug);
        }).catch(function(err) {
          console.error('[translate] Error: ' + title + ': ' + err.message);
        });
      });
    }, Promise.resolve()).then(function() {
      console.log('[translate] Done. Translated: ' + translated + ', Skipped: ' + skipped + ', Cached: ' + processed);
    });
  });
};
