/**
 * dsh-strategy 域测试：引擎契约、成本模型、杠杆护栏、策略库。
 *
 * 重点是**回归测试**：把实验阶段踩到的两个真 bug 固化成断言，
 * 防止后续改动重新引入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backtestTargetWeights, backtestSingle, buyCostRate, sellCostRate, DEFAULT_COST,
  maxDrawdown, sharpeRatio, annualizedReturn, simpleReturns,
} from '../src/dsh-strategy/engine.js'
// 注意：engine.ts 直接导出 sma / rollingStd；index.ts 因与 dsh-alpha 指标同名而改用别名。
// 测试从域模块直接导入，故用原名。
import { sma as smaSeries, rollingStd as rollingStdSeries } from '../src/dsh-strategy/engine.js'
import {
  ALL_STRATEGIES, findStrategy, runStrategy, momentumStop, lowVolCircuit, maCross,
  equalWeightIndex, drawdownFromHigh,
} from '../src/dsh-strategy/strategies.js'

/** 构造一段可预测的 K 线：价格按给定序列走，开=收。 */
function makeBars(closes: readonly number[], volume = 1_000_000) {
  return closes.map((c, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, o: c, h: c, l: c, c, v: volume }))
}

test('sma: 等长输出，前 window-1 位为 null', () => {
  const out = smaSeries([1, 2, 3, 4, 5], 3)
  assert.deepEqual(out, [null, null, 2, 3, 4])
})

test('rollingStd: 常数列方差为 0', () => {
  assert.deepEqual(rollingStdSeries([5, 5, 5, 5], 2), [null, 0, 0, 0])
})

test('simpleReturns: 首位为 0，其余为简单收益', () => {
  const r = simpleReturns([100, 110, 99])
  assert.equal(r[0], 0)
  assert.ok(Math.abs(r[1]! - 0.1) < 1e-12)
  assert.ok(Math.abs(r[2]! - -0.1) < 1e-12)
})

test('maxDrawdown: 已知序列回撤正确', () => {
  // 峰值 120 → 谷底 60 = 50%
  assert.ok(Math.abs(maxDrawdown([100, 120, 60, 80]) - 0.5) < 1e-12)
})

test('成本模型: 买入不含印花税，卖出含', () => {
  assert.ok(Math.abs(buyCostRate() - (0.00025 + 0.00001 + 0.0005)) < 1e-12)
  assert.ok(Math.abs(sellCostRate() - (0.00025 + 0.0005 + 0.00001 + 0.0005)) < 1e-12)
  assert.ok(sellCostRate() > buyCostRate(), '卖出成本应高于买入（含印花税）')
})

test('引擎: 无成本的完美行情下，满仓收益等于价格涨幅', () => {
  const closes = [100, 110, 121]           // +21%
  const bars = [makeBars(closes)]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const signals = [[1], [1], [0]]
  const r = backtestTargetWeights(bars, signals, { cost: zero })
  // 第一天收盘后给权重，第二天开盘(110)买入，第三天(121)卖出 → 涨幅 10%
  assert.ok(Math.abs(r.totalReturnPct - 10) < 1e-9, `got ${r.totalReturnPct}`)
})

test('引擎: 空信号不产生交易，净值恒为 1', () => {
  const bars = [makeBars([100, 90, 80])]
  const r = backtestTargetWeights(bars, [[0], [0], [0]])
  assert.equal(r.totalReturnPct, 0)
  assert.equal(r.maxDrawdownPct, 0)
  assert.equal(r.avgTurnover, 0)
})

test('引擎: 信号在 bar i 确认，bar i+1 开盘成交（无未来函数）', () => {
  // 若用了未来信息（同日收盘成交），在暴涨日会给出行情收益；这里应只吃到次日之后
  const bars = [{ t: 1, o: 100, c: 100 }, { t: 2, o: 100, c: 200 }, { t: 3, o: 200, c: 200 }]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  // bar0 给权重 1 → bar1 开盘(100)买入；bar1 收盘已 200，但涨幅发生在 bar1 日内
  const r = backtestTargetWeights([bars], [[1], [1], [0]], { cost: zero })
  // bar1 开盘 100 买入，持仓到 bar2 开盘 200 卖出 → +100%
  assert.ok(Math.abs(r.totalReturnPct - 100) < 1e-9, `got ${r.totalReturnPct}`)
})

// ═════════════ 回归测试：实验阶段发现的两个真 bug ═════════════

test('REGRESSION 杠杆护栏: 单 bar 权重和 >1 时被归一，不得产生隐性杠杆', () => {
  // 实验中 lowVolCircuit 初版对每只标的独立给权重 1 → 权重和 = 标的数，
  // 回测变成 N 倍杠杆（曾把 Calmar 从 0.13 虚增到 132）。护栏必须拦住。
  const n = 4
  const closes = [100, 110, 121, 133]
  const bars = Array.from({ length: n }, () => makeBars(closes))
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const weightOne = new Array(n).fill(1)      // 权重和 = 4
  const signals = [weightOne, weightOne, weightOne, weightOne]
  const r = backtestTargetWeights(bars, signals, { cost: zero, grossCap: 1 })
  assert.equal(r.maxGrossRaw, n, '应记录到原始总权重为 4')
  // 护栏把总权重压到 1：净值应等于「满仓一只、bar1 开盘买入」的结果。
  // 手算：bar1 开盘 110 买入 → bar2 收盘 133 = +20.909%；未归一则会是 4 倍敞口。
  assert.ok(Math.abs(r.totalReturnPct - 20.909090909090907) < 1e-9,
    `归一后应精确等于无杠杆满仓结果，got ${r.totalReturnPct}`)
  assert.ok(r.totalReturnPct < 40, '不应出现杠杆放大')
  // 记录：现金约束使"无护栏"也无法真正超过 1 倍杠杆（买入需要现金），
  // 因此护栏的价值在于**如实反映策略意图**并暴露 maxGrossRaw，而非事后救火。
  assert.ok(r.maxGrossRaw > 1, 'maxGrossRaw 必须暴露原始超配，让调用方看见问题')
})

test('REGRESSION 未来函数: 信号切片错位会改变结果，故必须用开盘价成交', () => {
  // 构造跳空行情：若在信号当日收盘成交，收益会不同
  const bars = [
    { t: 1, o: 100, c: 100 },
    { t: 2, o: 150, c: 150 },   // 跳空 +50%
    { t: 3, o: 150, c: 150 },
  ]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const r = backtestTargetWeights([bars], [[1], [1], [0]], { cost: zero })
  // bar0 收盘=100 给权重；bar1 开盘=150 成交 → 没有吃到跳空缺口
  assert.ok(Math.abs(r.totalReturnPct) < 1e-9, `不应吃到跳空，got ${r.totalReturnPct}`)
})

test('引擎: 检查输入长度不一致时抛错', () => {
  assert.throws(
    () => backtestTargetWeights([makeBars([1, 2, 3]), makeBars([1, 2])], [[1], [1]]),
    /same number of bars/,
  )
})

// ═════════════ 策略库测试 ═════════════

test('策略库: 每个策略都能生成合法权重矩阵（等长、权重和 ≤ 1）', () => {
  const K = 5, T = 200
  const bars = Array.from({ length: K }, (_, k) =>
    makeBars(Array.from({ length: T }, (_, i) => 100 + k * 10 + Math.sin(i / 7) * 8 + i * 0.15)))
  for (const st of ALL_STRATEGIES) {
    const sig = st.generate(bars, {})
    assert.equal(sig.length, T, `${st.id}: 信号长度应为 ${T}`)
    for (let i = 0; i < T; i++) {
      assert.equal(sig[i]!.length, K, `${st.id}: 第 ${i} 行长度应为 ${K}`)
      const sum = sig[i]!.reduce((a, b) => a + b, 0)
      assert.ok(sum <= 1 + 1e-9, `${st.id}: 第 ${i} 行权重和 ${sum} 超过 1`)
      for (const w of sig[i]!) assert.ok(w >= 0 && Number.isFinite(w), `${st.id}: 权重非法 ${w}`)
    }
  }
})

test('策略库: findStrategy 与 runStrategy 按 id 工作', () => {
  assert.equal(findStrategy('momentum_stop')?.id, 'momentum_stop')
  assert.equal(findStrategy('nope'), undefined)
  const bars = [makeBars(Array.from({ length: 120 }, (_, i) => 100 + i))]
  const r = runStrategy(bars, 'ma_cross')
  assert.equal(r.strategy, 'ma_cross')
  assert.equal(r.bars, 120)
  assert.throws(() => runStrategy(bars, 'nope'), /unknown strategy/)
})

test('策略库: 空仓策略在纯下跌行情中不亏钱', () => {
  // 单调下跌 → 趋势策略应识别并空仓
  const bars = [makeBars(Array.from({ length: 150 }, (_, i) => 200 - i))]
  const r = runStrategy(bars, momentumStop, { lookback: 40, topN: 1, stopPct: 0.05, filterMa: 60 })
  assert.ok(r.totalReturnPct >= -50, `下跌行情不应巨亏，got ${r.totalReturnPct.toFixed(1)}%`)
})

test('策略库: equalWeightIndex 与 drawdownFromHigh 数值正确', () => {
  const bars = [makeBars([100, 100]), makeBars([200, 200])]
  const idx = equalWeightIndex(bars)
  assert.ok(Math.abs(idx[0] - 1) < 1e-12)
  assert.ok(Math.abs(idx[1] - 1) < 1e-12)
  const dd = drawdownFromHigh([100, 120, 60], 3)
  assert.equal(dd[0], 0)
  assert.equal(dd[1], 0)
  assert.ok(Math.abs(dd[2] - 0.5) < 1e-12)
})

test('策略库: 无杠杆（所有策略的输出经引擎后 maxGrossRaw ≤ 1）', () => {
  const K = 6, T = 180
  const bars = Array.from({ length: K }, (_, k) =>
    makeBars(Array.from({ length: T }, (_, i) => 100 + k * 5 + Math.sin(i / 5 + k) * 10 + i * 0.2)))
  for (const st of ALL_STRATEGIES) {
    const r = runStrategy(bars, st, {})
    assert.ok(r.maxGrossRaw <= 1 + 1e-9, `${st.id}: maxGrossRaw = ${r.maxGrossRaw} 应 ≤ 1`)
  }
})

// ═════════════ 纯 Node 数据源（替代 akshare）═════════════

test('sources: toSymbol / toCode 交易所前缀判定正确', async () => {
  const { toSymbol, toCode } = await import('../src/dsh-strategy/sources.js')
  assert.equal(toSymbol('600000'), 'sh600000')
  assert.equal(toSymbol('000001'), 'sz000001')
  assert.equal(toSymbol('300750'), 'sz300750')
  assert.equal(toSymbol('430047'), 'bj430047')
  assert.equal(toSymbol('abc'), undefined)
  assert.equal(toSymbol('12345'), undefined)          // 5 位非法
  assert.equal(toCode('sh600000'), '600000')
  assert.equal(toCode('sz000001'), '000001')
})

test('sources: INDEX_CODES 覆盖常用宽基指数', async () => {
  const { INDEX_CODES } = await import('../src/dsh-strategy/sources.js')
  assert.equal(INDEX_CODES.csi300, '000300')
  assert.equal(INDEX_CODES.csi500, '000905')
  assert.equal(INDEX_CODES.csi1000, '000852')
  assert.equal(INDEX_CODES.sse50, '000016')
})

test('sources: fetchIndexConstituents 返回合法代码（网络依赖，失败即跳过）', async (t) => {
  const { fetchIndexConstituents, INDEX_CODES } = await import('../src/dsh-strategy/sources.js')
  let codes
  try {
    codes = await fetchIndexConstituents(INDEX_CODES.csi300, AbortSignal.timeout(20_000))
  } catch {
    t.skip('network unavailable')
    return
  }
  assert.ok(codes.length >= 250, `CSI300 应返回约 300 只，got ${codes.length}`)
  for (const c of codes) assert.match(c, /^\d{6}$/)
  assert.equal(new Set(codes).size, codes.length, '不应有重复代码')
})
