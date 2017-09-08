const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');
//zlib 服务端专用压缩数据库
const zlib = require('zlib');
const mime = require('./lib/mime');
const config = require('./config.json');

const hasTrailingSlash = url => url[url.length - 1] === '/';

class StaticServer {
    constructor() {
        this.port = config.port;
        this.root = __dirname + config.root;
        this.indexPage = config.indexPage;
        this.enableCacheControl = config.cacheControl;
        this.enableExpires = config.expires;
        this.enableETag = config.etag;
        this.enableLastModified = config.lastModified;
        this.maxAge = config.maxAge;
    }

    //服务器500错误返回
    respondError(err, res) {
        res.writeHead(500);
        return res.end(err);        
    }

    //服务404状态返回
    respondNotFound(req, res) {
        res.writeHead(404, {
            'Content-Type': 'text/html'
        });
        res.end(`<h1>Not Found</h1><p>The requested URL ${req.url} was not found on this server.</p>`);
    }

    //通过修改时间和文件大小计算文件etag标记
    generateETag(stat) {
        const mtime = stat.mtime.getTime().toString(16);
        const size = stat.size.toString(16);
        return `W/"${size}-${mtime}"`;
    }

    //response头缓存标记属性写入
    setFreshHeaders(stat, res) {
    	//获取文件的最后修改时间设置到 Last-Modified
        const lastModified = stat.mtime.toUTCString();
        if (this.enableExpires) {
            const expireTime = (new Date(Date.now() + this.maxAge * 1000)).toUTCString();
            //设置多少秒后资源过期，在资源过期前不过发起请求，但是用户F5或者点击Refresh按钮的时候就算对于有Expires的URI，一样也会发一个HTTP请求出去
            res.setHeader('Expires', expireTime);
        }
        if (this.enableCacheControl) {
        	//资源在本地缓存多少秒
        	//Expires = 时间，HTTP 1.0 版本，缓存的载止时间，允许客户端在这个时间之前不去检查（发请求）
			//max-age = 秒，HTTP 1.1版本，资源在本地缓存多少秒。
			//如果max-age和Expires同时存在，则被Cache-Control的max-age覆盖。
			//Expires 的一个缺点就是，返回的到期时间是服务器端的时间，这样存在一个问题，如果客户端的时间与服务器的时间相差很大，那么误差就很大，所以在HTTP 1.1版开始，使用Cache-Control: max-age=秒替代。
            res.setHeader('Cache-Control', `public, max-age=${this.maxAge}`);
        }
        if (this.enableLastModified) {
        	//标记资源最后修改时间，下次请求过来直接比较修改时间，未修改直接304，但是逃不掉的是一次http请求
            res.setHeader('Last-Modified', lastModified);
        }
        if (this.enableETag) {
        	//设置请求资源的etag，便于下次比较
            res.setHeader('ETag', this.generateETag(stat));
        }
    }

    //request 头验证请求是新鲜
    isFresh(reqHeaders, resHeaders) {
        const  noneMatch = reqHeaders['if-none-match'];
        const  lastModified = reqHeaders['if-modified-since'];
        if (!(noneMatch || lastModified)) return false;
        if(noneMatch && (noneMatch !== resHeaders['etag'])) return false;
        if(lastModified && lastModified !== resHeaders['last-modified']) return false;
        return true;
    }

    //判断是否配置为应该压缩文件
    shouldCompress(pathName) {
        return path.extname(pathName).match(this.zipMatch);
    }

    //请求响应
    respond(pathName, req, res) {
        fs.stat(pathName, (err, stat) => {
            if (err) return respondError(err, res);
            //写入缓存头到 response
            this.setFreshHeaders(stat, res);
            //验证文件是否过期
            if (this.isFresh(req.headers, res._headers)) {
            	//直接304
                this.responseNotModified(res);
            } else {
            	//读文件并返回
                this.responseFile(stat, pathName, req, res);
            }
        });

    }

    //文件未更改的请求响应
    responseNotModified(res) {
        res.statusCode = 304;
        res.end();
    }

	//判断浏览器是否支持 服务器资源压缩，支持压缩即启用对应压缩方案，gizp方案优先
    compressHandler(readStream, req, res) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (!acceptEncoding || !acceptEncoding.match(/\b(gzip|deflate)\b/)) {
            return readStream;
        } else if (acceptEncoding.match(/\bgzip\b/)) {
            res.setHeader('Content-Encoding', 'gzip');
            return readStream.pipe(zlib.createGzip());
        } else if (acceptEncoding.match(/\bdeflate\b/)) {
            res.setHeader('Content-Encoding', 'deflate');
            return readStream.pipe(zlib.createDeflate());
        }
    }

    //取出浏览器头中（如：Range: bytes=0-10）每次分段请求的大小
    getRange(rangeText, totalSize) {
        const matchResults = rangeText.match(/bytes=([0-9]*)-([0-9]*)/);
        let start = parseInt(matchResults[1]);
        let end = parseInt(matchResults[2]);
        if (isNaN(start) && !isNaN(end)) {
            start = totalSize - end;
            end = totalSize - 1;
        } else if (!isNaN(start) && isNaN(end)) {
            end = totalSize - 1;
        }
        return {
            start,
            end
        }
    }

    //写入response头，告诉浏览器文件是否发送完毕
    rangeHandler(pathName, rangeText, totalSize, res) {
        const range = this.getRange(rangeText, totalSize);
        if (range.start > totalSize || range.end > totalSize || range.start > range.end) {
            res.statusCode = 416;//416错误，告知浏览器request中Range的范围有误
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            res.end();
            return null;
        } else {
            res.statusCode = 206;//206告知浏览器 客户端通过发送范围请求头Range抓取到了资源的部分数据
            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
            //读取制定范围的文件流到内存
            return fs.createReadStream(pathName, { start: range.start, end: range.end });
        }
    }

    //根据请求头，读取文件流块到内存
    responseFile(stat, pathName, req, res) {
        let readStream;
        res.setHeader('Content-Type', mime.lookup(pathName));
        //该响应头表明服务器支持Range请求,以及服务器所支持的单位是字节(这也是唯一可用的单位).
        //我们还能知道:服务器支持断点续传,以及支持同时下载文件的多个部分,也就是说下载工具可以利用范围请求加速下载该文件
        res.setHeader('Accept-Ranges', 'bytes');
        //判断浏览器是否支持分段下载
        if (req.headers['range']) {
            readStream = this.rangeHandler(pathName, req.headers['range'], stat.size, res);
            if (!readStream) return;
        } else {
        	//读取整个文件流到内存
            readStream = fs.createReadStream(pathName);
        }
        if (this.shouldCompress(pathName)) {
        	//压缩文件流
            readStream = this.compressHandler(readStream, req, res);
        }
        readStream.pipe(res);
    }

    //对于不符合规范的文件夹请求修正为正确的请求地址进行重定向
    respondRedirect(req, res) {
        const location = req.url + '/';
        res.writeHead(301, {
            'Location': location,
            'Content-Type': 'text/html'
        });
        res.end(`Redirecting to <a href='${location}'>${location}</a>`);
    }

    //请求地址为文件夹路径时，优先读取配置默认index.html文件
    respondDirectory(pathName, req, res) {
        const indexPagePath = path.join(pathName, this.indexPage);
        if (fs.existsSync(indexPagePath)) {
            this.respond(indexPagePath, req, res);
        } else {
        	//异步读取文件夹下的所有文件目录
            fs.readdir(pathName, (err, files) => {
                if (err) {
                    respondError(err, res);
                }
                const requestPath = url.parse(req.url).pathname;
                let content = `<h1>Index of ${requestPath}</h1>`;
                files.forEach(file => {
                    let itemLink = path.join(requestPath,file);
                    const stat = fs.statSync(path.join(pathName, file));
                    if (stat && stat.isDirectory()) {
                        itemLink = path.join(itemLink, '/');
                    }                 
                    content += `<p><a href='${itemLink}'>${file}</a></p>`;
                });
                res.writeHead(200, {
                    'Content-Type': 'text/html'
                });
                res.end(content);
            });
        }
    }

    routeHandler(pathName, req, res) {
    	//读取文件基本信息（size, uid, dev, atime, mtime, ctime）
        fs.stat(pathName, (err, stat) => {
            if (!err) {
                const requestedPath = url.parse(req.url).pathname;
                //判断请求路径以/结尾,且当前文件夹存在
                if (hasTrailingSlash(requestedPath) && stat.isDirectory()) {
                    this.respondDirectory(pathName, req, res);
                } else if (stat.isDirectory()) {
                	//文件夹请求路径不对时重定向
                    this.respondRedirect(req, res);
                } else {
                	//正常文件请求
                    this.respond(pathName, req, res);
                }
            } else {
            	//404
                this.respondNotFound(req, res);
            }
        });
    }

    start() {
        http.createServer((req, res) => {
            const pathName = path.join(this.root, path.normalize(req.url));
            this.routeHandler(pathName, req, res);
        }).listen(this.port, err => {
            if (err) {
                console.info('1. 静态资源监听服务开启失败·····');
                console.error('2. ' + err);
            } else {
                console.info(`静态资源监听服务开启成功，端口号： ${this.port}`);
            }
        });
    }
}

module.exports = StaticServer;










