#!/usr/bin/env python3
"""烬冠竞技场 · 三职业 PvE + PvP 输出与生存数值仿真模型 (balance_model.py)

用法：
    python3 scripts/balance_model.py                      # 输出完整 PvE + PvP 对比报表
    python3 scripts/balance_model.py --proposed --csv /tmp/bal.csv   # 导出供 solo_report.py --model 使用的基准 CSV
"""
import argparse
import csv
import math
from dataclasses import dataclass
from typing import Dict, List, Tuple

DT = 0.02  # 20ms 仿真步长

# ==============================================================================
# 1. 曲线与怪物定义（同步自 public/index.html 的 BAL / ENEMY / BOONS）
# ==============================================================================
def bal_hp(n: int) -> float:
    return 1.70 + 0.130 * (n - 1) + 0.0128 * ((n - 1) ** 2)

def bal_dmg(n: int) -> float:
    return 1.00 + 0.050 * (n - 1) + 0.0006 * ((n - 1) ** 2)

def bal_budget(n: int) -> float:
    return (4 + 1.8 * (n - 1)) if (n % 5 == 0) else (6 + 2.2 * (n - 1))

def bal_boss_hp_mul(n: int) -> float:
    return 0.52 + 0.009 * (n - 1)

def bal_spawn_iv(n: int) -> float:
    return max(0.18, 0.50 - 0.015 * n)

def bal_cap(n: int) -> int:
    return min(26, 10 + n)

ENEMIES = {
    "goblin":   {"hp": 34,  "dmg": 8,  "cost": 1, "from": 1},
    "deepOne":  {"hp": 34,  "dmg": 8,  "cost": 1, "from": 1},
    "slime":    {"hp": 48 * 1.8, "dmg": 9, "cost": 2, "from": 2},  # 含分裂出的 2 只 0.4x 小史莱姆等效血池
    "skeleton": {"hp": 30,  "dmg": 9,  "cost": 2, "from": 3},
    "orc":      {"hp": 125, "dmg": 20, "cost": 4, "from": 4},
    "cultist":  {"hp": 52,  "dmg": 12, "cost": 3, "from": 6},
}
BOSSES = {5: ("ogre", 700), 10: ("lich", 820), 15: ("blackKnight", 760)}


def wave_stats(n: int) -> Dict[str, float]:
    """计算第 n 波的期望怪物数量、小怪总血池、首领血量、单次平均怪伤。"""
    pool = [v for v in ENEMIES.values() if v["from"] <= n]
    weights = [v["cost"] ** 1.3 for v in pool]
    wsum = sum(weights)
    avg_cost = sum(v["cost"] * w for v, w in zip(pool, weights)) / wsum
    avg_hp0 = sum(v["hp"] * w for v, w in zip(pool, weights)) / wsum
    avg_dmg0 = sum(v["dmg"] * w for v, w in zip(pool, weights)) / wsum

    budget = bal_budget(n)
    mob_count = budget / avg_cost
    whp = bal_hp(n)
    wdmg = bal_dmg(n)
    mob_hp_pool = mob_count * avg_hp0 * whp

    boss_hp = 0.0
    if n % 5 == 0:
        b_idx = ((n // 5 - 1) % 3 + 1) * 5
        _, b_base = BOSSES[b_idx]
        boss_hp = round(b_base * whp * bal_boss_hp_mul(n))

    return {
        "wave": n,
        "mobs": mob_count,
        "single_hp": avg_hp0 * whp,
        "mob_pool": mob_hp_pool,
        "boss_hp": boss_hp,
        "total_pool": mob_hp_pool + boss_hp,
        "avg_hit_dmg": avg_dmg0 * wdmg,
    }


# ==============================================================================
# 2. 祝福成长模型（按波次模拟贪心/均衡拿取）
# ==============================================================================
@dataclass
class BoonState:
    n_dmg: int = 0      # 巨人之力 (+18% 前4, +9% 之后)
    n_atk: int = 0      # 疾风之手 (+14% 前4, +7% 之后)
    n_hp: int = 0       # 铁石之躯 (+18% 前8, +24 之后)
    n_crit: int = 0     # 致命直觉 (+10%, 上限 6 层 -> 60% 暴击)
    n_cdr: int = 0      # 奥术沙漏 (×0.88, 上限 6 层 -> 0.50)
    n_mast: int = 0     # 武艺精通 (上限 4 层)
    n_arm: int = 0      # 守护符文 (×0.90)
    n_leech: int = 0    # 嗜血獠牙 (+3/杀，每秒上限 2% maxHp)

    @property
    def dmg_mul(self) -> float:
        m = 1.0
        for i in range(1, self.n_dmg + 1):
            m *= 1.09 if i > 4 else 1.18
        return m

    @property
    def atk_mul(self) -> float:
        m = 1.0
        for i in range(1, self.n_atk + 1):
            m *= 1.07 if i > 4 else 1.14
        return m

    @property
    def crit_rate(self) -> float:
        return min(0.60, 0.05 + 0.10 * self.n_crit)

    @property
    def crit_mul(self) -> float:
        # 暴击双倍伤害的期望乘区
        return 1.0 + self.crit_rate

    @property
    def cdr_mul(self) -> float:
        return max(0.50, 0.88 ** self.n_cdr)

    def max_hp(self, base_hp: int) -> int:
        hp = base_hp
        for i in range(1, self.n_hp + 1):
            g = max(24, round(hp * 0.18)) if i <= 8 else 24
            hp += g
        return hp

    def armor(self, base_armor: float) -> float:
        a = base_armor
        for _ in range(self.n_arm):
            if a > 0.42:
                a *= 0.90
        return a


def boons_at_wave(wave: int) -> BoonState:
    """模拟玩家在第 wave 波前累计获得的 (wave - 1) 个祝福分布（75% 进攻 + 25% 生存）。"""
    b = BoonState()
    order = ["mast", "dmg", "atk", "crit", "hp", "dmg", "cdr", "atk", "leech", "arm"]
    for i in range(max(0, wave - 1)):
        pick = order[i % len(order)]
        if pick == "mast" and b.n_mast < 4:
            b.n_mast += 1
        elif pick == "crit" and b.n_crit < 6:
            b.n_crit += 1
        elif pick == "cdr" and b.n_cdr < 6:
            b.n_cdr += 1
        elif pick == "arm" and b.n_arm < 5:
            b.n_arm += 1
        elif pick == "hp":
            b.n_hp += 1
        elif pick == "leech":
            b.n_leech += 1
        elif pick == "atk":
            b.n_atk += 1
        else:
            b.n_dmg += 1
    return b


# ==============================================================================
# 3. 时间步进战斗循环仿真器（支持 PvE 与 PvP 兩套数值）
# ==============================================================================
def sim_combat(
    cls: str,
    mode: str,         # "pve" or "pvp"
    targets: int = 1,  # 同时在射程/范围内的敌人数 (1=单挑/首领, 3=小群, 6=怪海)
    dur_s: float = 60.0,
    boons: BoonState = None,
    zone_hit_rate: float = 1.0,  # 延迟地面技能在移动战中的命中折扣（PvE=1.0, PvP=0.65）
    proposed: bool = False,
    live_orig: bool = False,     # 线上原版骑士（扇形挥砍 + 盾牌猛击 + E旋风斩 + U天降神剑0.95s读条）
) -> Dict[str, float]:
    """按 20ms 步长精确仿真技能冷却、资源生成/消耗、施法读条锁与旋风斩期间锁。"""
    b = boons or BoonState()
    dm = b.dmg_mul * b.crit_mul if mode == "pve" else 1.048  # PvP 自带 8% 暴击 ×1.6 = 1.048
    am = b.atk_mul if mode == "pve" else 1.0
    cdr = b.cdr_mul if mode == "pve" else 1.0
    mast = b.n_mast if mode == "pve" else 0

    if cls == "knight" and live_orig:
        # 线上原版骑士：普攻扇形(28/24) + Q盾猛(38/28, 5.2s, +15怒) + E旋风斩(68/48, 7.5s, 耗20怒) + U天降神剑(165/78, 20s, 耗35怒, 0.95s读条)
        atk_cd_base = 0.41 / am
        q_cd_base = 5.2 * cdr
        e_cd_base = 7.5 * cdr
        u_cd_base = 20.0 * cdr
        m_cd_base = 5.0
        res = 20.0
        atk_dmg = (28.0 if mode == "pve" else 24.0) * dm
        q_dmg = (38.0 if mode == "pve" else 28.0) * dm
        e_dmg = (68.0 if mode == "pve" else 48.0) * dm
        u_dmg = (165.0 if mode == "pve" else 78.0) * dm
        m_dmg = (38.0 if mode == "pve" else 28.0) * dm
        cd_atk = cd_q = cd_e = cd_u = cd_m = cast_t = 0.0
        tot_atk = tot_q = tot_e = tot_u = tot_m = 0.0
        for _ in range(int(round(dur_s / DT))):
            cd_atk = max(0.0, cd_atk - DT)
            cd_q = max(0.0, cd_q - DT)
            cd_e = max(0.0, cd_e - DT)
            cd_u = max(0.0, cd_u - DT)
            cd_m = max(0.0, cd_m - DT)
            res = min(100.0, res + (4.0 if targets > 1 else 2.5) * DT)
            if cast_t > 0:
                cast_t -= DT
                if cast_t <= 0:
                    res = max(0.0, res - 35.0)
                    cd_u = u_cd_base
                    tot_u += u_dmg * min(targets, 5) * zone_hit_rate
                continue
            if cd_m <= 0:
                cd_m = m_cd_base
                res = min(100.0, res + 25.0)
                tot_m += m_dmg * min(targets, 2)
            if cd_u <= 0 and res >= 35.0:
                cast_t = 0.95
                continue
            if cd_e <= 0 and res >= 20.0:
                res -= 20.0
                cd_e = e_cd_base
                tot_e += e_dmg * min(targets, 5)
            if cd_q <= 0:
                cd_q = q_cd_base
                res = min(100.0, res + 15.0)
                tot_q += q_dmg * min(targets, 3)
            if cd_atk <= 0:
                cd_atk = atk_cd_base
                hit_n = min(targets, 3 + (1 if mast >= 2 else 0))
                tot_atk += atk_dmg * hit_n
                res = min(100.0, res + (8.0 + 3.0 * hit_n if mode == "pve" else 12.0))
        tot = tot_atk + tot_q + tot_e + tot_u + tot_m
        return {
            "atk_dps": tot_atk / dur_s, "q_dps": tot_q / dur_s, "e_dps": tot_e / dur_s,
            "u_dps": tot_u / dur_s, "m_dps": tot_m / dur_s, "total_dps": tot / dur_s,
            "skill_pct": (tot - tot_atk) / tot * 100.0 if tot > 0 else 0.0, "wall_cov": 0.0,
        }

    # 改后方案：
    # - 骑士武艺精通：重斩每层额外溅射 +1 个副目标（65% 伤害），若周围仅 1 个目标（孤立首领）则主目标伤害 +15%/层；顺劈范围 +15%/层
    # - 法师武艺精通：火球爆炸范围 +25%/层，且法术伤害 +15%/层
    if proposed and mode == "pve":
        if cls == "mage":
            dm *= (1.0 + 0.15 * mast)

    if cls == "knight":
        atk_cd_base = 0.41 / am
        q_cd_base = (2.2 if proposed else 1.8) * cdr
        e_cd_base = 14.0 * cdr
        u_cd_base = 20.0 * cdr
        m_cd_base = 5.0
        res = 20.0
        q_cost, e_cost, u_cost = (18.0 if proposed else 18.0), 0.0, 35.0
        hit_rage = 14.0 if proposed else 18.0
        if proposed:
            atk_dmg = (30.0 if mode == "pve" else 23.0) * dm
            q_dmg = (52.0 if mode == "pve" else 34.0) * dm
            u_tick_dmg = (19.0 if mode == "pve" else 9.0) * dm
            m_dmg = (34.0 if mode == "pve" else 24.0) * dm
        else:
            atk_dmg = (34.0 if mode == "pve" else 28.0) * dm
            q_dmg = (56.0 if mode == "pve" else 40.0) * dm
            u_tick_dmg = (19.0 if mode == "pve" else 10.0) * dm
            m_dmg = (38.0 if mode == "pve" else 28.0) * dm
    elif cls == "ranger":
        atk_cd_base = (0.36 if mode == "pve" else 0.37) / am
        q_cd_base = 6.5 * cdr
        e_cd_base = 8.5 * cdr
        u_cd_base = 21.0 * cdr
        m_cd_base = 2.8
        res = 100.0
        q_cost, e_cost, u_cost = 25.0, 30.0, 45.0
        atk_dmg = (16.0 if mode == "pve" else 14.0) * dm
        q_dmg = (16.0 if mode == "pve" else 14.0) * dm
        e_tick_dmg = (16.0 if mode == "pve" else 13.0) * dm
        u_tick_dmg = (20.0 if mode == "pve" else 13.0) * dm
        m_dmg = 0.0
    else:  # mage
        atk_cd_base = 0.46 / am
        q_cd_base = 7.5 * cdr
        e_cd_base = 9.2 * cdr
        u_cd_base = 24.0 * cdr
        m_cd_base = 6.5
        res = 100.0
        q_cost, e_cost, u_cost = 20.0, 30.0, 45.0
        atk_dmg = (24.0 if mode == "pve" else 20.0) * dm
        q_dmg = (28.0 if mode == "pve" else 26.0) * dm
        e_dmg = (105.0 if mode == "pve" else 64.0) * dm
        u_tick_dmg = (60.0 if mode == "pve" else 30.0) * dm
        m_dmg = 0.0

    cd_atk = cd_q = cd_e = cd_u = cd_m = 0.0
    cast_t = 0.0
    spin_t = 0.0
    spin_tick = 0.0
    wall_t = 0.0
    wall_up_time = 0.0

    tot_atk = tot_q = tot_e = tot_u = tot_m = tot_heal = 0.0
    steps = int(round(dur_s / DT))

    for _ in range(steps):
        cd_atk = max(0.0, cd_atk - DT)
        cd_q = max(0.0, cd_q - DT)
        cd_e = max(0.0, cd_e - DT)
        cd_u = max(0.0, cd_u - DT)
        cd_m = max(0.0, cd_m - DT)

        if wall_t > 0:
            wall_t = max(0.0, wall_t - DT)
            wall_up_time += DT

        # 资源自然恢复（骑士在交战中受击也会回怒，PvE 怪多/PvP 换血按每秒轻微受击折算 +5 怒/s）
        if cls == "ranger":
            res = min(100.0, res + 9.0 * DT)
        elif cls == "mage":
            res = min(100.0, res + 6.5 * DT)
        else:
            res = min(100.0, res + (4.0 if targets > 1 else 2.5) * DT)

        # 骑士大招旋风斩持续生效中（可移动、可开 E 破釜，暂停普攻和 Q 顺劈）
        if spin_t > 0:
            spin_t = max(0.0, spin_t - DT)
            spin_tick -= DT
            if spin_tick <= 0:
                spin_tick += 0.30
                hit_n = min(targets, 4 + (1 if mast >= 2 else 0))
                tot_u += u_tick_dmg * hit_n
                tot_heal += min(2.0, 2.0 * hit_n)

        # 游侠/法师大招读条中（不可普攻、不可放 Q/E）
        if cast_t > 0:
            cast_t -= DT
            if cast_t <= 0:
                res = max(0.0, res - u_cost)
                cd_u = u_cd_base
                if cls == "ranger":
                    hit_n = min(targets, 5)
                    tot_u += (u_tick_dmg * 8) * hit_n * zone_hit_rate
                elif cls == "mage":
                    hit_n = min(targets, 6)
                    # 4 跳递增 [0.55, 0.85, 1.15, 1.45]，带 0.9s 减速使 PvP 命中率高于无减速延迟大招
                    eff_hit = min(1.0, zone_hit_rate + (0.18 if mode == "pvp" else 0.0))
                    tot_u += (u_tick_dmg * 4.0) * hit_n * eff_hit
            continue

        # 1) 骑士冲锋（每 5s 突进撞击 +25 怒）
        if cls == "knight" and cd_m <= 0:
            cd_m = m_cd_base
            res = min(100.0, res + 25.0)
            tot_m += m_dmg * min(targets, 2)

        # 2) 骑士 E 破釜沉舟（0 怒，14s CD，3s 80% 减伤）
        if cls == "knight" and cd_e <= 0:
            cd_e = e_cd_base
            wall_t = 3.0

        # 3) 大招 U
        if cd_u <= 0 and res >= u_cost and spin_t <= 0:
            if cls == "knight":
                res -= u_cost
                cd_u = u_cd_base
                spin_t = 2.4
                spin_tick = 0.0
            elif cls == "ranger":
                cast_t = 1.05
                continue
            else:
                cast_t = 1.80
                continue

        # 4) 2 号技能 E（游侠箭雨 / 法师陨石）
        if cls in ("ranger", "mage") and cd_e <= 0 and res >= e_cost:
            res -= e_cost
            cd_e = e_cd_base
            if cls == "ranger":
                hit_n = min(targets, 4)
                tot_e += (e_tick_dmg * 6) * hit_n * zone_hit_rate
            else:
                hit_n = min(targets, 4)
                tot_e += e_dmg * hit_n * zone_hit_rate

        # 5) 1 号技能 Q（骑士顺劈 / 游侠扇形齐射 / 法师冰环）
        if spin_t <= 0 and cd_q <= 0 and res >= q_cost:
            # 骑士如果大招快好了（cd_u < 1.8s 且怒气 < 35+18），优先憋怒气开大招
            if cls == "knight" and cd_u < 1.8 and res < (u_cost + q_cost):
                pass
            else:
                res -= q_cost
                cd_q = q_cd_base
                if cls == "knight":
                    hit_n = min(targets, 4 + (1 if mast >= 2 else 0))
                    tot_q += q_dmg * hit_n
                elif cls == "ranger":
                    # 扇形齐射：对单目标贴脸可中 1~2 支，对群怪可中 min(targets, 5)*1.3
                    hit_n = 1.35 if targets == 1 else min(targets * 1.35, 7.0)
                    tot_q += q_dmg * hit_n
                else:
                    hit_n = min(targets, 5)
                    tot_q += q_dmg * hit_n

        # 6) 普攻（1）
        if spin_t <= 0 and cd_atk <= 0:
            cd_atk = atk_cd_base
            if cls == "knight":
                if proposed and mode == "pve" and mast > 0:
                    extra_targets = min(targets - 1, mast)
                    if extra_targets > 0:
                        tot_atk += atk_dmg * (1.0 + 0.65 * extra_targets)
                    else:
                        # 孤立单目标（如首领）：武艺精通转化为 +15%/层 单体专注伤害
                        tot_atk += atk_dmg * (1.0 + 0.15 * mast)
                else:
                    tot_atk += atk_dmg
                res = min(100.0, res + hit_rage)
            elif cls == "ranger":
                # 射击：穿透 1 个敌人（最多打 2 个），武艺精通每层 +1 支箭（对单目标散射命中系数约 1 + 0.55*mast，对群怪全中）
                arrows = 1 + mast
                if targets == 1:
                    eff_hits = 1.0 + 0.55 * mast
                else:
                    eff_hits = min(targets, 2) * (1.0 + 0.85 * mast)
                tot_atk += atk_dmg * eff_hits
            else:
                # 火球：2.35m 溅射（对群怪命中 1 ~ 3.2 个）
                splash_targets = 1.0 if targets == 1 else min(targets, 2.2 + 0.35 * mast)
                tot_atk += atk_dmg * splash_targets

    tot = tot_atk + tot_q + tot_e + tot_u + tot_m
    return {
        "atk_dps": tot_atk / dur_s,
        "q_dps": tot_q / dur_s,
        "e_dps": tot_e / dur_s,
        "u_dps": tot_u / dur_s,
        "m_dps": tot_m / dur_s,
        "total_dps": tot / dur_s,
        "skill_pct": (tot - tot_atk) / tot * 100.0 if tot > 0 else 0.0,
        "wall_cov": wall_up_time / dur_s,
    }


# ==============================================================================
# 4. 报表打印与 CSV 导出
# ==============================================================================
def print_report():
    print("=" * 88)
    print("  烬冠竞技场 · 三职业 PvE & PvP 输出与生存仿真模型 (balance_model.py)")
    print("=" * 88)

    # ---- 第一部分：无祝福基础循环对比（PvE 单体 vs 3怪小群 vs 6怪群） ----
    print("\n【一、PvE 无祝福基础循环对账（60s 持续战斗）】")
    for tgt, title in [(1, "1 目标（单挑首领）"), (3, "3 目标（常规小怪群）"), (6, "6 目标（高密度怪堆）")]:
        print(f"\n  ▸ 场景：{title}")
        print(f"  {'职业':<8} {'普攻DPS':>8} {'Q(2)DPS':>8} {'E(3)DPS':>8} {'U(4)DPS':>8} {'位移DPS':>8} {'总DPS':>9} {'技能占比':>8}")
        print("  " + "-" * 74)
        for cls, cname in [("knight", "铁誓骑士"), ("ranger", "翠林游侠"), ("mage", "余烬法师")]:
            r = sim_combat(cls, "pve", targets=tgt, dur_s=60.0)
            print(
                f"  {cname:<8} {r['atk_dps']:>8.1f} {r['q_dps']:>8.1f} {r['e_dps']:>8.1f} "
                f"{r['u_dps']:>8.1f} {r['m_dps']:>8.1f} {r['total_dps']:>9.1f} {r['skill_pct']:>7.1f}%"
            )

    # ---- 第二部分：PvE 随波次成长（1 → 50 波，含祝福软上限、首领 TTK、清波耗时、站桩致死） ----
    print("\n【二、PvE 波次推进与祝福成长对账（含软上限 · 4目标混合期望）】")
    print(
        f"  {'波次':>4} {'总血池':>8} {'首领血':>7} │ "
        f"{'骑士DPS':>8} {'清波s':>6} {'首领s':>6} {'致死s':>6} │ "
        f"{'游侠DPS':>8} {'清波s':>6} {'首领s':>6} │ "
        f"{'法师DPS':>8} {'清波s':>6} {'首领s':>6}"
    )
    print("  " + "-" * 96)
    for w in [1, 5, 10, 15, 20, 25, 30, 40, 50]:
        ws = wave_stats(w)
        boons = boons_at_wave(w)
        row_s = {}
        for cls, base_hp, base_arm in [("knight", 215, 0.74), ("ranger", 140, 0.90), ("mage", 136, 0.90)]:
            pack = sim_combat(cls, "pve", targets=4, dur_s=60.0, boons=boons)
            boss = sim_combat(cls, "pve", targets=1, dur_s=60.0, boons=boons)
            # 清波时长 = 小怪血池/群DPS + 首领血/单体DPS + 刷怪铺场修正
            clear_s = ws["mob_pool"] / pack["total_dps"] + (ws["boss_hp"] / boss["total_dps"] if ws["boss_hp"] else 0.0) + 2.5
            boss_ttk = ws["boss_hp"] / boss["total_dps"] if ws["boss_hp"] else 0.0
            # 站桩致死时间（按 i-frame 0.5s 每秒最多吃 2 次伤害，骑士计入破釜沉舟 3/14s 80% 减伤等效减免）
            hp_max = boons.max_hp(base_hp)
            arm = boons.armor(base_arm)
            wall_factor = (1.0 - 0.80 * (3.0 / (14.0 * boons.cdr_mul))) if cls == "knight" else 1.0
            hit_taken = max(1.0, ws["avg_hit_dmg"] * arm * wall_factor)
            ttd = hp_max / (hit_taken * 2.0)
            row_s[cls] = (pack["total_dps"], clear_s, boss_ttk, ttd)

        k_dps, k_clr, k_btk, k_ttd = row_s["knight"]
        r_dps, r_clr, r_btk, _ = row_s["ranger"]
        m_dps, m_clr, m_btk, _ = row_s["mage"]
        b_str = f"{ws['boss_hp']:>7.0f}" if ws["boss_hp"] else "      -"
        kb_s = f"{k_btk:>5.1f}s" if ws["boss_hp"] else "     -"
        rb_s = f"{r_btk:>5.1f}s" if ws["boss_hp"] else "     -"
        mb_s = f"{m_btk:>5.1f}s" if ws["boss_hp"] else "     -"
        print(
            f"  w{w:<3d} {ws['total_pool']:>8.0f} {b_str} │ "
            f"{k_dps:>8.1f} {k_clr:>5.1f}s {kb_s} {k_ttd:>5.1f}s │ "
            f"{r_dps:>8.1f} {r_clr:>5.1f}s {rb_s} │ "
            f"{m_dps:>8.1f} {m_clr:>5.1f}s {mb_s}"
        )

    # ---- 第三部分：PvP 联机模式对账（1v1 单挑 & 3人混战 & 换血胜负矩阵） ----
    print("\n【三、PvP 联机模式输出与等效身板对账（server.js / P2PHost 权威数值）】")
    print("  （注：延迟地面圈技能在 PvP 移动博弈中按 65% 有效命中率折算；骑士计入破釜沉舟 3s 80% 减伤）")
    print(f"  {'职业':<8} {'HP':>4} {'被动减伤':>8} {'基础EHP':>8} {'含破釜EHP':>10} │ {'1v1 DPS':>8} {'3人混战DPS':>10} {'6秒爆发伤':>10}")
    print("  " + "-" * 84)
    pvp_stats = {}
    for cls, cname, hp, arm in [
        ("knight", "铁誓骑士", 215, 0.74),
        ("ranger", "翠林游侠", 140, 0.90),
        ("mage",   "余烬法师", 136, 0.90),
    ]:
        duel = sim_combat(cls, "pvp", targets=1, dur_s=30.0, zone_hit_rate=0.65)
        brawl = sim_combat(cls, "pvp", targets=3, dur_s=30.0, zone_hit_rate=0.65)
        burst6 = sim_combat(cls, "pvp", targets=1, dur_s=6.0, zone_hit_rate=0.70)["total_dps"] * 6.0
        base_ehp = hp / arm
        # 1v1 约 8~10 秒决胜负，骑士必开出 1 次 3 秒破釜沉舟（3s 内减伤 80%）+ 1 次大招回 ~8 HP
        eff_ehp = (hp + 8) / (arm * ((3.0 * 0.2 + 6.0 * 1.0) / 9.0)) if cls == "knight" else base_ehp
        pvp_stats[cls] = {"name": cname, "duel_dps": duel["total_dps"], "brawl_dps": brawl["total_dps"], "ehp": eff_ehp, "base_ehp": base_ehp}
        print(
            f"  {cname:<8} {hp:>4d} {(1-arm)*100:>7.0f}% {base_ehp:>8.1f} {eff_ehp:>10.1f} │ "
            f"{duel['total_dps']:>8.1f} {brawl['total_dps']:>10.1f} {burst6:>10.1f}"
        )

    print("\n  ▸ PvP 1v1 贴脸对拼击杀耗时 (TTK) 矩阵（考虑近战追击 85% 贴身覆盖率 vs 远程 95% 命中率）：")
    uptime = {"knight": 0.85, "ranger": 0.92, "mage": 0.90}
    pairs = [("knight", "ranger"), ("knight", "mage"), ("ranger", "mage")]
    for a, b in pairs:
        sa, sb = pvp_stats[a], pvp_stats[b]
        ttk_a_kills_b = sb["ehp"] / (sa["duel_dps"] * uptime[a])
        ttk_b_kills_a = sa["ehp"] / (sb["duel_dps"] * uptime[b])
        winner = sa["name"] if ttk_a_kills_b < ttk_b_kills_a else sb["name"]
        print(
            f"    • {sa['name']} vs {sb['name']}：{sa['name']} 击杀需 {ttk_a_kills_b:4.1f}s │ "
            f"{sb['name']} 击杀需 {ttk_b_kills_a:4.1f}s  → 优势方：{winner}"
        )


def export_csv(path: str):
    rows = []
    for w in range(1, 51):
        ws = wave_stats(w)
        boons = boons_at_wave(w)
        # 取三职业平均清波时间作为 --model 基准
        clrs = []
        for cls in ("knight", "ranger", "mage"):
            pack = sim_combat(cls, "pve", targets=4, dur_s=60.0, boons=boons)
            boss = sim_combat(cls, "pve", targets=1, dur_s=60.0, boons=boons)
            c = ws["mob_pool"] / pack["total_dps"] + (ws["boss_hp"] / boss["total_dps"] if ws["boss_hp"] else 0.0) + 2.5
            clrs.append(c)
        rows.append({
            "wave": w,
            "mobs": round(ws["mobs"], 1),
            "total_pool": round(ws["total_pool"], 1),
            "boss_hp": round(ws["boss_hp"], 1),
            "clear_s": round(sum(clrs) / len(clrs), 2),
        })
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["wave", "mobs", "total_pool", "boss_hp", "clear_s"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n已导出模型基准 CSV: {path}")


def print_compare():
    print("=" * 102)
    print("  烬冠竞技场 · 骑士三版对照（线上原版 vs my-vm现版 vs 校准改后版）+ 游侠/法师基准")
    print("=" * 102)

    print("\n【一、PvE 无祝福基线总 DPS 对照（60s 循环）】")
    print(f"  {'场景':<16} │ {'骑士·线上原版':>13} │ {'骑士·my-vm现版':>14} │ {'骑士·校准改后':>13} │ {'游侠(基准)':>10} │ {'法师(基准)':>10}")
    print("  " + "-" * 92)
    for tgt, title in [(1, "1目标(单挑首领)"), (3, "3目标(常规小怪)"), (6, "6目标(高密怪堆)")]:
        kl = sim_combat("knight", "pve", targets=tgt, live_orig=True)
        k0 = sim_combat("knight", "pve", targets=tgt, proposed=False)
        k1 = sim_combat("knight", "pve", targets=tgt, proposed=True)
        r0 = sim_combat("ranger", "pve", targets=tgt, proposed=True)
        m0 = sim_combat("mage", "pve", targets=tgt, proposed=True)
        print(
            f"  {title:<16} │ {kl['total_dps']:>6.1f}({kl['skill_pct']:>4.0f}%) │ "
            f"{k0['total_dps']:>7.1f}({k0['skill_pct']:>4.0f}%) │ "
            f"{k1['total_dps']:>6.1f}({k1['skill_pct']:>4.0f}%) │ "
            f"{r0['total_dps']:>10.1f} │ {m0['total_dps']:>10.1f}"
        )

    print("\n【二、PvE 波次推进与祝福成长对照（w1 → w50 · 4目标混合期望 DPS & 首领 TTK）】")
    print(
        f"  {'波次':>4} {'总血池':>7} {'首领血':>6} │ "
        f"{'骑士: 线上原版 → my-vm现版 → 校准改后 (首领s: 原/现/后)':>52} │ "
        f"{'游侠DPS(首领s)':>15} │ "
        f"{'法师: 现 → 后 (首领s)':>23}"
    )
    print("  " + "-" * 116)
    for w in [1, 5, 10, 15, 20, 25, 30, 40, 50]:
        ws = wave_stats(w)
        boons = boons_at_wave(w)
        kl_p = sim_combat("knight", "pve", targets=4, boons=boons, live_orig=True)["total_dps"]
        k0_p = sim_combat("knight", "pve", targets=4, boons=boons, proposed=False)["total_dps"]
        k1_p = sim_combat("knight", "pve", targets=4, boons=boons, proposed=True)["total_dps"]
        kl_b = sim_combat("knight", "pve", targets=1, boons=boons, live_orig=True)["total_dps"]
        k0_b = sim_combat("knight", "pve", targets=1, boons=boons, proposed=False)["total_dps"]
        k1_b = sim_combat("knight", "pve", targets=1, boons=boons, proposed=True)["total_dps"]

        r_p = sim_combat("ranger", "pve", targets=4, boons=boons, proposed=True)["total_dps"]
        r_b = sim_combat("ranger", "pve", targets=1, boons=boons, proposed=True)["total_dps"]

        m0_p = sim_combat("mage", "pve", targets=4, boons=boons, proposed=False)["total_dps"]
        m1_p = sim_combat("mage", "pve", targets=4, boons=boons, proposed=True)["total_dps"]
        m0_b = sim_combat("mage", "pve", targets=1, boons=boons, proposed=False)["total_dps"]
        m1_b = sim_combat("mage", "pve", targets=1, boons=boons, proposed=True)["total_dps"]

        b_str = f"{ws['boss_hp']:>6.0f}" if ws["boss_hp"] else "     -"
        kb_s = f"({ws['boss_hp']/kl_b:>4.1f}/{ws['boss_hp']/k0_b:>4.1f}/{ws['boss_hp']/k1_b:>4.1f}s)" if ws["boss_hp"] else "                 "
        rb_s = f"({ws['boss_hp']/r_b:>4.1f}s)" if ws["boss_hp"] else "       "
        mb_s = f"({ws['boss_hp']/m0_b:>4.1f}→{ws['boss_hp']/m1_b:>4.1f}s)" if ws["boss_hp"] else "            "
        k_col = f"{kl_p:>6.0f} → {k0_p:>6.0f} → {k1_p:>6.0f} {kb_s}"
        r_col = f"{r_p:>7.0f} {rb_s}"
        m_col = f"{m0_p:>5.0f}→{m1_p:>5.0f} {mb_s}"
        print(f"  w{w:<3d} {ws['total_pool']:>7.0f} {b_str} │ {k_col:>52} │ {r_col:>15} │ {m_col:>23}")

    print("\n【三、PvP 联机模式对照（1v1 单挑 / 3人混战 / 1v1 击杀耗时）】")
    print(f"  {'版本/职业':<16} {'基础EHP':>8} {'实战EHP':>9} │ {'1v1 DPS':>8} {'3人混战DPS':>10} {'6秒爆发伤':>10} │ {'杀游侠/被游侠杀':>16}")
    print("  " + "-" * 88)
    r_duel = sim_combat("ranger", "pvp", targets=1, dur_s=30.0, zone_hit_rate=0.65)["total_dps"]
    r_brawl = sim_combat("ranger", "pvp", targets=3, dur_s=30.0, zone_hit_rate=0.65)["total_dps"]
    r_burst = sim_combat("ranger", "pvp", targets=1, dur_s=6.0, zone_hit_rate=0.70)["total_dps"] * 6.0
    r_ehp = 140.0 / 0.90

    m_duel = sim_combat("mage", "pvp", targets=1, dur_s=30.0, zone_hit_rate=0.65)["total_dps"]
    m_brawl = sim_combat("mage", "pvp", targets=3, dur_s=30.0, zone_hit_rate=0.65)["total_dps"]
    m_burst = sim_combat("mage", "pvp", targets=1, dur_s=6.0, zone_hit_rate=0.70)["total_dps"] * 6.0
    m_ehp = 136.0 / 0.90

    for label, kw, eff_ehp in [
        ("骑士·线上原版", {"live_orig": True}, (215.0 + 18.0) / 0.74),          # 原版E旋风回18血，无破釜80%减伤
        ("骑士·my-vm现版", {"proposed": False}, (215.0 + 8.0) / (0.74 * (3*0.2+6*1.0)/9.0)),
        ("骑士·校准改后", {"proposed": True}, (215.0 + 8.0) / (0.74 * (3*0.45+6*1.0)/9.0)),
    ]:
        duel = sim_combat("knight", "pvp", targets=1, dur_s=30.0, zone_hit_rate=0.65, **kw)["total_dps"]
        brawl = sim_combat("knight", "pvp", targets=3, dur_s=30.0, zone_hit_rate=0.65, **kw)["total_dps"]
        burst = sim_combat("knight", "pvp", targets=1, dur_s=6.0, zone_hit_rate=0.70, **kw)["total_dps"] * 6.0
        ttk_k = r_ehp / (duel * 0.72)
        ttk_r = eff_ehp / (r_duel * 0.92)
        print(f"  {label:<16} {215/0.74:>8.1f} {eff_ehp:>9.1f} │ {duel:>8.1f} {brawl:>10.1f} {burst:>10.1f} │ {ttk_k:>6.1f}s / {ttk_r:>5.1f}s")
    print(f"  {'翠林游侠(基准)':<16} {r_ehp:>8.1f} {r_ehp:>9.1f} │ {r_duel:>8.1f} {r_brawl:>10.1f} {r_burst:>10.1f} │       —")
    print(f"  {'余烬法师(基准)':<16} {m_ehp:>8.1f} {m_ehp:>9.1f} │ {m_duel:>8.1f} {m_brawl:>10.1f} {m_burst:>10.1f} │       —")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proposed", action="store_true", help="兼容旧命令行参数")
    ap.add_argument("--compare", action="store_true", help="输出改前 vs 改后完整对比表")
    ap.add_argument("--csv", help="导出逐波模型基准 CSV（供 solo_report.py --model 使用）")
    args = ap.parse_args()
    if args.compare:
        print_compare()
    else:
        print_report()
    if args.csv:
        export_csv(args.csv)


if __name__ == "__main__":
    main()
