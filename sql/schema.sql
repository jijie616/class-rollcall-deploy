-- 课堂随机点名系统 —— 建表脚本
-- 负责人：李文龙（A2）
-- 设计目标：兼容 MySQL 5.5 ~ 8.0；实际已验证 SQLPub MySQL 8.0.41。
--
-- 兼容性约束（改动本文件前务必阅读）：
--   1. MySQL 5.6.5 之前，CURRENT_TIMESTAMP 只能作为 TIMESTAMP 列的默认值，
--      用在 DATETIME 上会报 Error 1067: Invalid default value。故统一用 TIMESTAMP。
--   2. MySQL 5.5 中每张表只能有一个 TIMESTAMP 列带 DEFAULT CURRENT_TIMESTAMP。
--      本文件中每表恰好一个（roll_records.called_at、score_logs.created_at），
--      其余时间戳列一律写 TIMESTAMP NULL 且不给默认值。
--   3. 不用 JSON 类型（需 5.7.8+），名单快照用 TEXT 存 JSON 字符串。
--   4. 不建物理外键，完整性由应用层保证（见博客 3.2 类图说明）。
--
-- 2026-10-16：真实 SQLPub 8.0.41 建表成功、无警告；MySQL 5.5 等其他版本未验收。

SET NAMES utf8mb4;

-- ----------------------------
-- 学生表
-- ----------------------------
CREATE TABLE IF NOT EXISTS students (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  sno           VARCHAR(20)   NOT NULL UNIQUE COMMENT '学号，必须存字符串（保留前导零）',
  name          VARCHAR(50)   NOT NULL        COMMENT '姓名',
  major         VARCHAR(50)   NULL            COMMENT '专业',
  on_call_count INT           NOT NULL DEFAULT 0 COMMENT '随机点名次数（顺序点名不计入）',
  score         DECIMAL(6,2)  NOT NULL DEFAULT 0 COMMENT '总积分，0.5 步长'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生名单与积分汇总';

-- ----------------------------
-- 点名记录表（含结算字段）
-- 一次点名对应一次结算，settled 标志天然实现"重复请求不能重复加分"
-- ----------------------------
CREATE TABLE IF NOT EXISTS roll_records (
  id              BIGINT       AUTO_INCREMENT PRIMARY KEY,
  sno             VARCHAR(20)  NOT NULL,
  mode            ENUM('random','sequence') NOT NULL,
  rnd_seed        BIGINT       NULL COMMENT '随机种子，仅 random 模式；复演校验用',
  min_score       DECIMAL(6,2) NULL COMMENT '抽签时刻名单最低分',
  roster_snapshot TEXT         NULL COMMENT '抽签时刻名单快照 JSON [{sno,score}]；复演校验用',
  present         TINYINT      NULL COMMENT 'NULL=未登记；1=到场；0=未到场',
  repeat_result   ENUM('accurate','inaccurate','none') NULL COMMENT '复述结果；none=未提问',
  answer_bonus    DECIMAL(6,2) NULL COMMENT '回答加分 0~3，0.5 步长',
  delta           DECIMAL(6,2) NULL COMMENT '本次积分总增量',
  settled         TINYINT      NOT NULL DEFAULT 0 COMMENT '0=未结算；1=已结算，防重复加分',
  settled_at      TIMESTAMP    NULL,
  called_at       TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sno (sno),
  INDEX idx_time (called_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点名记录与结算结果';

-- ----------------------------
-- 积分流水表（审计链：每笔变动可追溯到具体某次点名）
-- ----------------------------
CREATE TABLE IF NOT EXISTS score_logs (
  id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
  sno        VARCHAR(20)  NOT NULL,
  roll_id    BIGINT       NULL COMMENT '关联 roll_records.id',
  delta      DECIMAL(6,2) NOT NULL,
  reason     VARCHAR(100) NULL COMMENT '加分/扣分原因',
  created_at TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sno (sno),
  INDEX idx_roll (roll_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='积分变动流水';
