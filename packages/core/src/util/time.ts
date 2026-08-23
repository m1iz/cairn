/**
 * 时间工具 (MIG-FND-004)。
 *
 * 对齐 Python：`control/models.now_ts`、`team/models.now_ts` 返回**秒**（float）；
 * `scheduler/models.now_ms` 返回**毫秒**（int）。两套并存，迁移时按原子系统选用，磁盘时间戳口径不变。
 */

/** 当前时间，秒（float）。对齐 Python `now_ts()`。 */
export function nowTs(): number {
  return Date.now() / 1000
}

/** 当前时间，毫秒（int）。对齐 Python `now_ms()`。 */
export function nowMs(): number {
  return Date.now()
}
