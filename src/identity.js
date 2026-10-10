/**
 * 插件对外身份常量。
 *
 * 单独成文件的理由很实际：provider 名同时被配置写入（`rivet-config.js`）与
 * key 池写入（`provider-keys.js`）使用，若两边互相 import 就会形成模块环。
 * 身份值放在这里，两边都只依赖它，环不存在。
 *
 * @module tianshu-workbuddy-connect/identity
 */

/** 本插件在天枢里注册的 provider 名。也是 `provider-keys.json` 里的键。 */
export const PROVIDER_NAME = 'workbuddy'

/** 插件 id —— 与 package.json 的 `tianshu.name` 必须一致（安装目录名同理）。 */
export const PLUGIN_ID = 'tianshu-workbuddy-connect'
