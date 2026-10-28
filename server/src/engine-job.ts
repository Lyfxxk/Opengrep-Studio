/**
 * 实验室运行、规则包质量检查与引擎升级共用的全局互斥标志。
 * 单独放在依赖最简的叶子模块做单一归属：引擎 / 规则包 / 实验室三个资源域的路由都要读写它，
 * 放进任何一路由模块都会造成路由模块间的横向依赖；出现多副本则互斥直接失效。
 */

let engineJobBusy = false;

export function isEngineJobBusy(): boolean {
  return engineJobBusy;
}

export function setEngineJobBusy(busy: boolean): void {
  engineJobBusy = busy;
}
