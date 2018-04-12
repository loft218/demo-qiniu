/**
 * 七牛云服务
 * 使用 qiniu nodejs sdk
 * https://github.com/qiniu/nodejs-sdk/releases
 * 
 * Node.js SDK 文档
 * https://developer.qiniu.com/kodo/sdk/nodejs
 */

const co = require('co');
const assert = require('assert');
const qiniu = require('qiniu');
const debug = require('debug')('dudu.core.lib.qiniu');
const log4js = require('log4js');
const logger = log4js.getLogger('qiniu');
const path = require('path');
const request = require('request-promise');

const qiniuConf = require('./config');
const model = require('../../model');

qiniu.conf.ACCESS_KEY = qiniuConf.access_key;
qiniu.conf.SECRET_KEY = qiniuConf.secret_key;


/**
 * 获取上传凭证
 * 
 * @param {String} [dir] 存储分类，建议根据约定传值
 * @param {Object} [policyOptions] 策略参数
 *   参见：https://developer.qiniu.com/kodo/manual/put-policy#put-policy-persistent-ops-explanation
 * 
 * @return {Object} 上传凭证
 */
function genUploadToken(dir, policyOptions) {
    dir = dir || 'public';
    assert(typeof (policyOptions) === 'object');

    policyOptions = policyOptions || {};
    let putPolicyObj = Object.assign({}, qiniuConf.put_policy, policyOptions);
    putPolicyObj.saveKey = `${dir}/${putPolicyObj.saveKey}`;
    debug('saveKey:%s', putPolicyObj.saveKey);

    let putPolicy = new qiniu.rs.PutPolicy2(putPolicyObj);
    debug('putPolicy:%o', putPolicy);

    let token = putPolicy.token();
    debug('token:%o', token);

    return token;
}

/**
 * 获取Object
 */
function getObject(objId) {
    return model['qiniu.objects'].findById(objId).exec();
}

/** 获取指定Object的persistent信息 */
function getPersistent(objId, persistentFlag) {
    assert(objId, 'obj_id required');
    assert(persistentFlag, 'persistent_flag required');
    return model['qiniu.persistents'].findOne({ obj_id: objId, flag: persistentFlag }).exec();
}

/** 回调处理 */
function callbackHandle(data) {
    return co(function* () {
        debug('callbackHandle data:%o', data);
        let qiniuObj = yield new model['qiniu.objects'](data).save();
        let ret = {
            obj_id: qiniuObj._id,
            url: `http://${qiniuConf.domain}/${qiniuObj.key}`
        };

        // 如果上传的是视频，请求持久化处理
        if (qiniuObj.mime_type.indexOf('video') > -1) {
            //视频截图的格式
            const vframeDestFormatter = 'jpg';
            //截取指定时长位置的帧
            const vframeOffset = 0.001;

            let parserKey = path.parse(`${qiniuObj.key}`);
            // 视频转码，目标格式mp4，存储Key=("avthumb/mp4/"+源Key)
            let avthumbMp4Fn = [parserKey.dir, parserKey.name + '.mp4'].join('/');
            let avthumbMp4Key = `avthumb/mp4/${avthumbMp4Fn}`;

            // 视频截图，截取第n秒的画面，存储Key=("vframe/"+源Key)
            let avthumbVFrameFn = [parserKey.dir, parserKey.name + '.' + vframeDestFormatter].join('/');
            let vframeKey = `vframe/${avthumbVFrameFn}`;

            debug('vframeKey:%s', vframeKey);
            debug('avthumbMp4Key:%s', avthumbMp4Key);

            let vframeKeyB64 = new Buffer(`${qiniuConf.bucket}:${vframeKey}`).toString('base64');
            let avthumbMp4KeyB64 = new Buffer(`${qiniuConf.bucket}:${avthumbMp4Key}`).toString('base64');

            // var wmText = urlbase64('视频来自' + (qiniuObj.end_user || '嘟嘟音乐'));
            // var wmParam = `wmText/${wmText}/wmFontSize/14/wmFontColor/I0ZGRkZGRg==`;
            let opsTasks = [];
            opsTasks.push(`vframe/${vframeDestFormatter}/offset/${vframeOffset}|saveas/${vframeKeyB64}`);
            opsTasks.push(`avthumb/mp4|saveas/${avthumbMp4KeyB64}`);
            debug('ops tasks:%s', opsTasks);

            qiniuObj.persistent_info = {
                avthumb_img: vframeKey,
                avthumb_mp4: avthumbMp4Key,
                ops: opsTasks,
            };
            yield qiniuObj.save();

            //返回转码后的视频地址及缩略图地址
            ret.avthumb_img = `http://${qiniuConf.domain}/${vframeKey}`;
            ret.avthumb_mp4 = `http://${qiniuConf.domain}/${avthumbMp4Key}`;
            //返回视频时长
            if (qiniuObj.avinfo) {
                try {
                    let avinfo = JSON.parse(qiniuObj.avinfo);
                    ret.duration = Number(avinfo.video.duration).toFixed(2);
                } catch (e) {
                    logger.error('avinfo parse failed');
                }
            }

            // 持久化请求之：视频截图
            persistentStart(qiniuObj._id, 'vframe', qiniuObj.bucket, qiniuObj.key, opsTasks[0], { pipeline: qiniuConf.persistent.pipeline });
            // 持久化请求之：转码Mp4
            persistentStart(qiniuObj._id, 'avthumb_mp4', qiniuObj.bucket, qiniuObj.key, opsTasks[1], { pipeline: qiniuConf.persistent.pipeline });
        }
        // 如果上传的是图片，返回image_info
        if (qiniuObj.mime_type.indexOf('image') > -1) {
            ret.image_info = qiniuObj.image_info;

            // 兼容现有图片机制，生成_base图，后面可以去掉 20170822
            if (Number(data.base) === 1) {
                var client = new qiniu.rs.Client();
                let objKeyArr = qiniuObj.key.split('.');
                objKeyArr.splice(-1, 0, '_base.');
                let destKey = objKeyArr.join('');
                client.copy(qiniuObj.bucket, qiniuObj.key, qiniuObj.bucket, destKey, (rerr, result) => {
                    if (rerr) logger.error(rerr);
                    logger.info(result);
                });
            }
            // 获取图片md5
            let resBody = yield request({
                uri: `${ret.url}?qhash/md5`,
                method: 'GET',
                json: true
            });
            if (resBody.hash) {
                ret.md5 = resBody.hash;
            }
        }
        return ret;
    });
}

/**
 * 持久化操作通知处理
 */
function persistentNotifyHandle(data) {
    return model['qiniu.persistents']
        .update({ pid: data.id }, { result: data, time_end: parseInt(Date.now()) })
        .exec();
}

/** 资源持久化开始 */
function persistentStart(objId, flag, bucket, key, ops, options) {
    assert(objId, 'obj_id required');
    assert(bucket, 'bucket required');
    assert(key, 'key required');
    assert(ops, 'ops required');
    options = options || {};
    let notifyUrl = options.pipeline.notify_url || qiniuConf.persistent.notify_url;
    let pipeline = options.pipeline || qiniuConf.persistent.pipeline;
    qiniu.fop.pfop(bucket, key, ops, {
        notifyURL: notifyUrl,
        force: options.force || 0,
        pipeline: pipeline
    }, function (rerr, result, res) {
        if (rerr) {
            logger.error(rerr);
            logger.error(res);
        }
        let perObj = {
            obj_id: objId,
            flag,
            bucket,
            key,
            pid: result.persistentId,
            ops,
            pipeline: pipeline
        };
        new model['qiniu.persistents'](perObj).save();
    });
}

function urlbase64(str) {
    return new Buffer(str).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

exports.genUploadToken = genUploadToken;
exports.getObject = getObject;
exports.getPersistent = getPersistent;
exports.callbackHandle = callbackHandle;
exports.persistentNotifyHandle = persistentNotifyHandle;
