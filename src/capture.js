"use strict";

const _ = require('lodash'),
      fs = require('fs-extra'),
      logger = require('winston'),
      path = require('path'),
      squirrel = require('squirrel'),
      crypto = require('crypto'),
      utils = require('./utils'),

      SCRIPT_FILE = 'scripts/screenshot.js',
      DEF_ENGINE = 'phantomjs',
      DEF_COMMAND = 'phantomjs',
      DEF_FORMAT = 'png',
      IMIN_MODULES = [
          'imagemin',
          'imagemin-gifsicle',
          'imagemin-jpegtran',
          'imagemin-optipng',
          'imagemin-svgo'
      ],
      IMIN_OPTIONS = {
          allowInstall: true
      };

const queue = require('bull')('manet capture',6379,'redis')

/* Configurations and options */

function outputFile(options, conf) {
    const json = JSON.stringify(options),
          sha1 = crypto.createHash('sha1').update(json).digest('hex'),
          format = options.format || DEF_FORMAT;
    return conf.storage + path.sep + sha1 + '.' + format;
}

function cliCommand(config) {
    const engine = config.engine || DEF_ENGINE,
          command = config.command || config.commands[engine][process.platform];
    return command || DEF_COMMAND;
}

function createOptions(options, config) {
    const opts = _.omit(options, ['force', 'callback']);
    opts.url = utils.fixUrl(options.url);
    return _.defaults(opts, config.options);
}

function createConfig(options, config) {
    const conf = _.cloneDeep(config),
          engine = options.engine;
    conf.engine = engine || conf.engine;
    return conf;
}


/* Image processing */

function minimizeImage(src, dest, cb) {
    squirrel(
        IMIN_MODULES, IMIN_OPTIONS,
        (err, Imagemin) => {
            const safeCb = (err) => {
                if (err) {
                    logger.error(err);
                }
                cb();
            };

            if (err) {
                safeCb(err);
            } else {
                const imin = new Imagemin()
                    .src(src)
                    .dest(dest)
                    .use(Imagemin.jpegtran({progressive: true}))
                    .use(Imagemin.optipng({optimizationLevel: 3}))
                    .use(Imagemin.gifsicle({interlaced: true}))
                    .use(Imagemin.svgo());

                imin.run(safeCb);
            }
        }
    );
}

/* Screenshot capturing runner */

function runCapturingProcess(options, config, outputFile, base64, onFinish) {
    const scriptFile = utils.filePath(SCRIPT_FILE),
          command = cliCommand(config).split(/[ ]+/),
          cmd = _.union(command, [scriptFile, base64, outputFile]),
          opts = {
              timeout: config.timeout
          };

    utils.execProcess(cmd, opts, (error) => {
        if (config.compress) {
            minimizeImage(outputFile, config.storage, () => onFinish(error));
        } else {
            onFinish(error);
        }
    });
}

const numWorkers = 8 // TODO: add config option numWorkers

queue.process( numWorkers, (job,done) => {

    logger.debug('Processing job: %s', job.data.opts.url)
    logger.debug('...file:', job.data.file)
    if (fs.exists(job.data.file)) {
        logger.debug('...skipping, file exists')
        done()
    } else {
        runCapturingProcess(job.data.opts, job.data.conf, job.data.file, job.data.base64, (error) => {
              logger.debug('Process finished work: %s', job.data.opts.url)
              done(error)
        })
    }
})

/* External API */

function screenshot(options, config, onFinish) {
    const conf = createConfig(options, config),
          opts = createOptions(options, config),
          base64 = utils.encodeBase64(opts),
          file = outputFile(opts, conf),
          timeout = conf.cache * 1000,

          retrieveImageFromStorage = () => {
              logger.debug('Take screenshot from file storage: %s', base64);

              utils.processOldFile(file, timeout, (file) => {
                 logger.debug('...file is to old, update it')
                 queue.add( { opts: opts, conf:conf, file:file, base64:base64 })
              } )
              onFinish(file);
          },
          retrieveImageFromSite = () => {

              queue.add( { opts: opts, conf:conf, file:file, base64:base64 })

              logger.debug('... sending noise')
              return onFinish('/srv/manet/public/noise.png')

              runCapturingProcess(opts, conf, file, base64, (error) => {
                  logger.debug('Process finished work: %s', base64);
                  return onFinish(file, error);
              });
          };

    logger.info('Capture site screenshot: "%s"', options.url);
    logger.info('... file: "%s"', file);

    if (options.force || !conf.cache) {
        retrieveImageFromSite();
    } else {
        fs.exists(file, (exists) =>
            exists ? retrieveImageFromStorage() : retrieveImageFromSite());
    }
}


/* Exported functions */

module.exports = {
    screenshot: screenshot
};
