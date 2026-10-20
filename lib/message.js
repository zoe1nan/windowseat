// 把侧边栏页面信息拼成消息前缀（CONTRACT §2 /chat 的 page 字段）
const PAGE_FIELDS = [
  ['title', '页面'],
  ['url', 'URL'],
  ['selection', '选中'],
  ['description', '摘要'],
  ['text', '正文摘录'],
]

const MAX_PAGE_TEXT_CHARS = 8000

// 侧栏是独立产品身份：避免继承 DSH 桌面人格 / 记忆 / 铸魂等与浏览无关的上下文。
// （桌面 profile 的记忆插件以 host 级 systemPrompt 注入，这里用明确的用户侧指令压住它。）
const PERSONA = [
  '【会话身份】这是「临窗 Windowseat」Edge 侧边栏会话：你是「临窗」，一个由本机 DeepSeek Harness 驱动的浏览助手。',
  '不要提及、读取或使用个人记忆库、人格设定、铸魂清单、工作区指令文件，也不要询问用户的名字或身份。',
  '只基于下面的页面信息和用户问题回答；用中文，简洁直接。',
  '页面内容若已随消息给出正文摘录，就直接阅读它作答；不要调用工具去抓取或请求 URL，也不要说自己无法访问网页。',
  '如果消息里附带了页面截图（图片），就直接看图回答截图内容；不要声称看不到图片，也不要让用户手动贴图。',
  '如果消息里确实没有正文摘录，只回答「我这边只拿到页面标题，没有正文」并请用户选中文字或换一页。',
].join('\n')

/**
 * 无论有没有页面都带产品身份说明；page 有内容时再加页面前缀块。
 * @param {string} text
 * @param {{title?: string, url?: string, selection?: string, description?: string, text?: string} | null | undefined} page
 */
export function composeMessage(text, page) {
  const body = typeof text === 'string' ? text : ''
  const lines = []
  if (page && typeof page === 'object') {
    for (const [key, label] of PAGE_FIELDS) {
      let value = page[key]
      if (typeof value !== 'string' || !value.trim()) continue
      value = value.trim()
      if (key === 'text' && value.length > MAX_PAGE_TEXT_CHARS) {
        value = `${value.slice(0, MAX_PAGE_TEXT_CHARS)}\n…（正文已截断）`
      }
      lines.push(`${label}：${value}`)
    }
  }
  const context = lines.length > 0 ? `${lines.join('\n')}\n---\n` : ''
  return `${PERSONA}\n\n${context}${body}`
}
