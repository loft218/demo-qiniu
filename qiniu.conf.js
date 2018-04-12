module.exports = {
    access_key: '<access_key>',
    secret_key: '<secret_key>',

    bucket: '<bucket>',
    domain: '<domain>',
    persistent: {
        /** nginx config */
        notify_url: 'http://<domain>/qiniu/persistent-notify',
        pipeline: '<pipeline>'
    },
    put_policy: {
        'scope': '<scope>',
        'saveKey': '$(year)$(mon)/$(etag)$(ext)',
        'expires': 3600,
        'insertOnly': 1,
        /** 100M */
        'fsizeLimit': 1024 * 1024 * 100,
        /** nginx config */
        'callbackUrl': 'http://<domain>/qiniu/callback',
        'callbackHost': '<domain>',
        'callbackBody': 'bucket=$(bucket)&key=$(key)&etag=$(etag)&fname=$(fname)&fsize=$(fsize)&mime_type=$(mimeType)&end_user=$(endUser)&image_info=$(imageInfo)&avinfo=$(avinfo)&ext=$(ext)&uuid=$(uuid)',
        'callbackBodyType': 'application/x-www-form-urlencoded',
        'callbackFetchKey': 0,
    }
};
