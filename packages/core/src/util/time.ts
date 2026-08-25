/**
 * 时间工具。
 *
 * 对齐 Python：`control/models.now_ts`、`team/models.now_ts` 返回**秒**（float）；
 * `scheduler/models.now_ms` 返回**毫秒**（int）。两套并存，迁移时按原子系统选用，磁盘时间戳口径不变。
 */

/** 当前时间，秒（float）。 */
export function nowTs(): number {
  return Date.now() / 1000
}

/** 当前时间，毫秒（int）。 */
export function nowMs(): number {
  return Date.now()
}
