// 浏览器 bundle 的 Node 全局占位：仓库内同构模块对 process/Buffer 的引用
// 全部被 `typeof x !== "undefined"` 守卫（如 env.ts），运行时不会触达。
// 声明为 any：typeof 守卫窄化后仍允许属性访问（Node 端才有的形状）。
declare const process: any;
declare const Buffer: any;
