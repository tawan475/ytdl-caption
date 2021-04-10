const fs       = require('fs');
const ytdl     = require('ytdl-core');
const https    = require('https');
const xml2srt  = require('yt-xml2srt');
const stream   = require("stream");
const P        = require("path");
const cp       = require('child_process');
const ffmpeg   = require('ffmpeg-static');
const readline = require('readline');
const ytpl     = require('ytpl');
const ffmpegVerbose = false;
const ffmpegShowBanner = false;
const Verbose = false;


const Path = './download/';


if (!fs.existsSync('./.temp'))          fs.mkdirSync('./.temp');
if (!fs.existsSync('./toDownload.txt')) fs.writeFileSync('./toDownload.txt', '');
if (!fs.existsSync(Path))               fs.mkdirSync(Path, { recursive: true });

const urls     = fs.readFileSync('./toDownload.txt', 'utf8').replace(/\/\*\/(.*)?/g, "").split(/\r\n/g).filter(s => s).map(l => {ls=l.split(" ");return {url:ls[0].replace(/\&list\=.*/g, ""),langs:ls[1]?ls[1].split("/"):['en']}});

dls(urls)

async function dls(urls){
    for (url of urls) {
        if (!ytpl.validateID(url.url)){
            var result = await download(url.url, url.langs, Path);
            console.log(`Downloaded: ${result.info.videoDetails.title}${Verbose?` at ${result.path}`:``}`);
            continue;
        }
        var playlist = await ytpl(url.url, { limit: Infinity });
        var playlistPath = Path + playlist.title.replace(/[\\/:*?"<>|]/g, "") + "/";
        if (!fs.existsSync(playlistPath)) fs.mkdirSync(playlistPath, { recursive: true });
        for (video of playlist.items) {
            var result = await download(video.shortUrl, url.langs, playlistPath);
            console.log(`Downloaded: ${result.info.videoDetails.title}${Verbose?` at ${result.path}`:``}`);
        }
    }
    fs.rmdirSync(`./.temp`, { recursive: true });
    console.log("DONE!");
}

async function download(url, langs = ["en"], path){
    return new Promise(async (Resolve) => {
        var info = await ytdl.getInfo(url, {lang: langs[0]});
        var tracks = info.player_response.captions ? info
          .player_response.captions
          .playerCaptionsTracklistRenderer.captionTracks
          : undefined;
        console.log(`Downloading ${info.videoDetails.title}`)
        var hasTracks = (tracks && tracks.length);
        if (hasTracks) {
            if (Verbose) console.log(`Found captions for ${info.videoDetails.title}`);
            var track = tracks.find(a => langs.find(b => tracks.find(h=> h.languageCode === b)) === a.languageCode);
            if (track) {
                var srt = await xml2srt
                    .Parse(await get(track.baseUrl))
                    .catch(err => console.log(`Error XML to SRT: ${err}`));
                fs.writeFileSync(`./.temp/${info.videoDetails.videoId}.${track.languageCode}.srt`, srt);
              } else {
                if (Verbose) console.log(`Could not find ${langs.join(", ")} caption for ${info.videoDetails.title}`);
            }
        } else {
          if (Verbose) console.log(`No captions found for ${info.videoDetails.title}`);
        }

        const tracker = {
            start: Date.now(),
            audio: { downloaded: 0, total: Infinity },
            video: { downloaded: 0, total: Infinity },
            merged: { frame: 0, speed: '0x', fps: 0 },
        };
            
        var audio = ytdl(url, { quality: 'highestaudio' })
          .on('progress', (_, downloaded, total) => {
            tracker.audio = { downloaded, total };
        });
        var video = ytdl(url, { quality: 'highestvideo' })
          .on('progress', (_, downloaded, total) => {
            tracker.video = { downloaded, total };
        });
        let Path = P.resolve(__dirname, path+info.videoDetails.title.replace(/[\\/:*?"<>|]/g, "").replace(/ /g, "_").substring(0,250)+".mkv");
        
        console.log();

        let progressbarHandle = null;
        const progressbarInterval = 100;
        const toMB = i => (i / 1024 / 1024).toFixed(2);
        const showProgress = () => {
            readline.clearScreenDown(process.stdout);
            var downloaded = (tracker.audio.downloaded+tracker.video.downloaded);
            var total = tracker.audio.total+tracker.video.total
            var totalMB = toMB(total);
            var downloadedMB = toMB(downloaded).padStart(totalMB.length, " ");
            let percent = ( downloaded / total )*100
            let bar = 2.5
            console.log(`Download | ${((percent).toFixed(2)+"%").padStart(7, " ")} [${'='.repeat(Math.round(percent/bar))}${' '.repeat((100/bar)-(Math.round(percent/bar)))}] (${downloadedMB}MB / ${totalMB}MB)`);
            console.log(`running for: ${((Date.now() - tracker.start) / 1000).toFixed(2)}s`);
            readline.cursorTo(process.stdout, 0);
            readline.moveCursor(process.stdout, 0, -2);
        };


        var ffmpegProcess = cp.spawn(ffmpeg, [
          (ffmpegVerbose?'':'-loglevel'), (ffmpegVerbose?'':'8'), (ffmpegShowBanner?'':'-hide_banner'),
          '-thread_queue_size', '1024',
          
          '-progress', 'pipe:3',
          '-i', 'pipe:4',
          '-i', 'pipe:5',
          (track?'-i':''), (track?`./.temp/${info.videoDetails.videoId}.${track.languageCode}.srt`:''),
          
          '-map', '0:a',
          '-map', '1:v',
          (track?'-map':''), (track?'2:s':''),
          
          
          '-scodec', 'copy',
          '-c:v', 'copy',
          '-c:a', 'copy',
          
          '-y',
          Path
        ].filter(s=>s), {
          windowsHide: true,
          stdio: [
            'inherit', 'inherit', 'inherit',
            'pipe', 'pipe', 'pipe'
          ]
        });
        ffmpegProcess.on('close', () => {
            if (track) fs.unlinkSync(`./.temp/${info.videoDetails.videoId}.${track.languageCode}.srt`);
            clearInterval(progressbarHandle);
            showProgress();
            readline.cursorTo(process.stdout, 0);
            readline.moveCursor(process.stdout, 0, -2);
            readline.clearScreenDown(process.stdout);
            Resolve({info: info, path: Path});
        });
        ffmpegProcess.stdio[3].on('data', chunk => {
            // Start the progress bar
            if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);
            // Parse the param=value list returned by ffmpeg
            const lines = chunk.toString().trim().split('\n');
            const args = {};
            for (const l of lines) {
                const [key, value] = l.split('=');
                args[key.trim()] = value.trim();
            }
            tracker.merged = args;
        });
        audio.pipe(ffmpegProcess.stdio[4]);
        video.pipe(ffmpegProcess.stdio[5]);
    })
}

async function get(url){
    return new Promise((resolve) => {
        https.get(url, res => {
            res.setEncoding("utf8");
            let data = "";
            res.on('data', chunk => { data += chunk })
            res.on('end', () => {
               resolve(data);
            });
        }); 
    });
}
