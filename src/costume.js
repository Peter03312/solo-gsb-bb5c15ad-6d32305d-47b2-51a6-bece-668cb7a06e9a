// 演员换装核查
// 为同一演员相邻两条到位口令（一个区段）登记换装区域与所需整数秒数（每个区段最多一项）。
// 核查按当前走位模式（区段独立 / 连续口令延误传导）取该区段的实际出发时刻，依次推演：
//   第一段：区段起点区域 → 换装区域（时间依赖 Dijkstra，封闭时段造成等待或绕行）；
//   换装：到达换装区域时刻 + 所需秒数 = 换装完成时刻；
//   第二段：换装区域 → 区段终点区域（自换装完成时刻起再次时间依赖推演）。
// 两段均计入通道封闭造成的等待或绕行，不直接相加静态最短耗时。
// 核查仅评估该区段本身，不改写原走位推演结果：
//   最终到达 ≤ 下一口令时刻为 ✅ 准时，否则 ❌ 迟到；
//   任一段在连接图上不连通为 ⛔ 不可达；
//   口令 / 区域失效或两条口令已不再是相邻口令为 ⚠️ 无法评估。

const { earliestArrival } = require('./graph');
const { simulateActor } = require('./validate');

/** 换装所需秒数上限（整数秒） */
const MAX_CHANGE_SECONDS = 3600;

/** 同一演员按时间升序的相邻口令对中，from → to 是否构成一个有效区段 */
function adjacentSegmentError(data, actorId, fromCueId, toCueId) {
  const areaIds = new Set(data.areas.map((a) => a.id));
  const cues = data.cues
    .filter((c) => c.actorId === actorId && areaIds.has(c.areaId))
    .slice()
    .sort((x, y) => x.time - y.time);
  const fromIdx = cues.findIndex((c) => c.id === fromCueId);
  const toIdx = cues.findIndex((c) => c.id === toCueId);
  if (fromIdx === -1 || toIdx === -1) return '口令未参与走位推演（其目标区域可能已删除）';
  if (toIdx !== fromIdx + 1) return '两条口令必须是同一演员按时间相邻的到位口令（先 → 后）';
  return null;
}

/** 清理失效换装任务：任一端口令或换装区域不存在时移除（删除口令 / 区域 / 演员后保持引用一致） */
function pruneCostumeChanges(data) {
  const cueIds = new Set(data.cues.map((c) => c.id));
  const areaIds = new Set(data.areas.map((a) => a.id));
  data.costumeChanges = (data.costumeChanges || []).filter(
    (t) => t && cueIds.has(t.fromCueId) && cueIds.has(t.toCueId) && areaIds.has(t.areaId)
  );
}

/** 路线渲染：与校验结果一致的逐边结构（出发 / 到达时刻、等待位置与时长） */
function renderRoute(route, nameOf) {
  return {
    arrivalTime: route.time,
    path: route.legs.length > 0 ? route.legs.map((l) => nameOf(l.toId)) : [],
    legs: route.legs.map((l) => ({
      edgeId: l.edgeId,
      fromName: nameOf(l.fromId),
      toName: nameOf(l.toId),
      departTime: l.depart,
      arriveTime: l.arrive,
      waitSeconds: l.wait,
      travelSeconds: l.arrive - l.depart,
    })),
    waits: route.legs.filter((l) => l.wait > 0).map((l) => ({ areaName: nameOf(l.fromId), seconds: l.wait })),
  };
}

/**
 * 评估全部换装任务（只读，不影响走位校验、通道冲突与依赖评估）。
 * @param {object} data 数据（areas / edges / actors / cues / costumeChanges）
 * @param {string} mode 校验模式（classic / propagate），与页面当前模式一致
 * @returns {{ items: Array, summary: object }}
 *   items[i]：{ id, actorId, actorName, from, to, changeAreaId, changeAreaName, seconds,
 *     depart, leg1, changeDone, leg2, finalArrival, margin, status, reason }
 *     - depart：区段实际出发时刻（当前模式）；
 *     - leg1 / leg2：两段最早路线（含等待明细），不可达为 null；
 *     - changeDone：换装完成时刻（到达换装区 + 所需秒数）；
 *     - margin：相对下一口令时刻的余量（正为准时余量，负为迟到缺口）；
 *     - status：ok（准时）/ fail（迟到）/ unreachable（不可达）/ invalid（无法评估）。
 */
function evaluateCostumeChanges(data, mode) {
  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const nameOf = (id) => areaName.get(id) || id;
  const actorById = new Map(data.actors.map((a) => [a.id, a]));
  const actorIndex = new Map(data.actors.map((a, i) => [a.id, i]));
  const cueById = new Map(data.cues.map((c) => [c.id, c]));
  const list = Array.isArray(data.costumeChanges) ? data.costumeChanges : [];

  // 同一演员可能有多项换装任务，推演结果按演员缓存复用
  const simCache = new Map();
  const simOf = (actor) => {
    if (!simCache.has(actor.id)) simCache.set(actor.id, simulateActor(data, actor, mode));
    return simCache.get(actor.id);
  };

  const items = list.map((task) => {
    const fromCue = cueById.get(task.fromCueId);
    const toCue = cueById.get(task.toCueId);
    const changeArea = data.areas.find((a) => a.id === task.areaId);
    const actor = fromCue ? actorById.get(fromCue.actorId) : null;

    const item = {
      id: task.id,
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.name : '（已删除演员）',
      from: fromCue
        ? { cueId: fromCue.id, time: fromCue.time, areaName: nameOf(fromCue.areaId), note: fromCue.note || '' }
        : { cueId: task.fromCueId },
      to: toCue
        ? { cueId: toCue.id, time: toCue.time, areaName: nameOf(toCue.areaId), note: toCue.note || '' }
        : { cueId: task.toCueId },
      changeAreaId: task.areaId,
      changeAreaName: changeArea ? changeArea.name : '（已删除区域）',
      seconds: task.seconds,
      depart: null, // 区段实际出发时刻（当前模式）
      leg1: null, // 起点 → 换装区 最早路线
      changeDone: null, // 换装完成时刻
      leg2: null, // 换装区 → 终点 最早路线
      finalArrival: null, // 最终到达时刻
      margin: null, // 相对下一口令时刻的余量（负为缺口）
      status: 'invalid',
      reason: '',
    };

    if (!fromCue || !toCue) {
      item.reason = '关联口令已删除（任务为失效残留，将在下次保存时清理）';
      return item;
    }
    if (!changeArea) {
      item.reason = '换装区域已删除（任务为失效残留，将在下次保存时清理）';
      return item;
    }
    if (!actor) {
      item.reason = '演员已删除（任务为失效残留，将在下次保存时清理）';
      return item;
    }
    if (fromCue.actorId !== toCue.actorId) {
      item.reason = '两条口令不属于同一演员，无法构成换装区段';
      return item;
    }

    // 区段必须仍是该演员按时间相邻的两条口令；实际出发时刻取自当前模式的逐段推演
    const sim = simOf(actor);
    const seg = sim.segments.find((s) => s.from.id === fromCue.id && s.to.id === toCue.id);
    if (!seg) {
      item.reason = '两条口令已不再是该演员相邻的到位口令（区段不存在），请删除后重新登记';
      return item;
    }
    item.depart = seg.depart;

    // 第一段：区段起点 → 换装区（封闭时段等待 / 绕行由时间依赖推演计入）
    const leg1 = earliestArrival(data.edges, fromCue.areaId, changeArea.id, seg.depart);
    if (!leg1) {
      item.status = 'unreachable';
      item.reason = `起点「${nameOf(fromCue.areaId)}」无法到达换装区「${changeArea.name}」（连接图不连通）`;
      return item;
    }
    item.leg1 = renderRoute(leg1, nameOf);
    item.changeDone = leg1.time + task.seconds;

    // 第二段：换装结束后自换装区 → 区段终点（自换装完成时刻重新推演，不与第一段静态相加）
    const leg2 = earliestArrival(data.edges, changeArea.id, toCue.areaId, item.changeDone);
    if (!leg2) {
      item.status = 'unreachable';
      item.reason = `换装区「${changeArea.name}」无法到达终点「${nameOf(toCue.areaId)}」（连接图不连通）`;
      return item;
    }
    item.leg2 = renderRoute(leg2, nameOf);
    item.finalArrival = leg2.time;
    item.margin = toCue.time - leg2.time;
    item.status = item.margin >= 0 ? 'ok' : 'fail';
    return item;
  });

  // 展示顺序：按演员顺序 → 起点口令时刻 → 任务 ID（失效任务无演员，排最后）
  const rank = (it) => (it.actorId !== null && actorIndex.has(it.actorId) ? actorIndex.get(it.actorId) : Number.MAX_SAFE_INTEGER);
  items.sort(
    (x, y) =>
      rank(x) - rank(y) ||
      (x.from.time ?? 0) - (y.from.time ?? 0) ||
      String(x.id).localeCompare(String(y.id))
  );

  return {
    items,
    summary: {
      total: items.length,
      ok: items.filter((i) => i.status === 'ok').length,
      fail: items.filter((i) => i.status === 'fail').length,
      unreachable: items.filter((i) => i.status === 'unreachable').length,
      invalid: items.filter((i) => i.status === 'invalid').length,
    },
  };
}

module.exports = { evaluateCostumeChanges, pruneCostumeChanges, adjacentSegmentError, MAX_CHANGE_SECONDS };
