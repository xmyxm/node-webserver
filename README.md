# node-webserver
静态资源服务器

本地启动简单

运行 node servre.js 文件即可

文件配置设定在 config.json文件中，如下：

{
    "port": 8088,监听端口号

    "root": "/dist",静态文件资源目录

    "indexPage": "index.html",默认打开页面

    "cacheControl": true,开启缓存

    "expires": true,

    "etag": true,

    "lastModified": true,

    "maxAge": 600,

    "zipMatch": "^\\.(css|js|html)$"    
}
