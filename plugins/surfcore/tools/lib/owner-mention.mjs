// 评论的 @ 需要昵称到账号 ID 的映射；缺失时拒绝分享，不能降级成纯文本。
export function ownerMentionMapping(owner = {}) {
  const name = String(owner.name ?? '').trim()
  const raw = String(owner.mid ?? '').trim()
  const mid = Number(raw)
  if (!name || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(mid)) {
    throw new Error('分享评论需要有效的主人 B站昵称和 UID')
  }
  return { [name]: mid }
}
