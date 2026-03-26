import * as path from 'path'
import * as url from 'url'
import * as fs from 'fs'
import wp from 'webpack'
import { AngularWebpackPlugin } from '@ngtools/webpack'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const linkerPlugin = createEs2015LinkerPlugin({
    linkerJitMode: true,
    fileSystem: {
        resolve: path.resolve,
        exists: fs.existsSync,
        dirname: path.dirname,
        relative: path.relative,
        readFile: fs.readFileSync,
    },
})

export default {
    target: 'electron-renderer',
    entry: './renderer/src/index.ts',
    devtool: 'source-map',
    output: {
        path: path.resolve(__dirname, 'renderer/dist'),
        filename: 'index.js',
        publicPath: '',
    },
    mode: 'development',
    optimization: { minimize: false },
    resolve: {
        modules: [
            path.resolve(__dirname, 'renderer/src'),
            path.resolve(__dirname, 'node_modules'),
        ],
        extensions: ['.ts', '.js'],
        mainFields: ['esm2015', 'browser', 'module', 'main'],
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                enforce: 'pre',
                use: {
                    loader: 'source-map-loader',
                    options: {
                        filterSourceMappingUrl: (_, resourcePath) =>
                            !/node_modules/.test(resourcePath),
                    },
                },
            },
            {
                test: /\.(m?)js$/,
                loader: 'babel-loader',
                options: {
                    plugins: [linkerPlugin],
                    compact: false,
                    cacheDirectory: true,
                },
                resolve: { fullySpecified: false },
            },
            {
                test: /\.ts$/,
                use: [{ loader: '@ngtools/webpack' }],
            },
            {
                test: /\.pug$/,
                use: [
                    { loader: 'raw-loader' },
                    {
                        loader: 'pug-html-loader',
                        options: { pretty: true, exports: false, data: {} },
                    },
                ],
            },
            {
                test: /\.scss$/,
                use: ['style-loader', 'css-loader', 'sass-loader'],
                exclude: /component\.scss/,
            },
            {
                test: /\.scss$/,
                use: ['@tabby-gang/to-string-loader', 'css-loader', 'sass-loader'],
                include: /component\.scss/,
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
            {
                test: /\.svg/,
                use: ['svg-inline-loader'],
            },
            {
                test: /\.(png|jpe?g|gif|woff|woff2|ttf|eot|otf)$/,
                type: 'asset',
            },
        ],
    },
    externals: [
        'electron',
        'fs',
        'path',
        'os',
        'child_process',
    ],
    plugins: [
        new wp.SourceMapDevToolPlugin({
            exclude: [/node_modules/, /vendor/],
            filename: '[file].map',
        }),
        new AngularWebpackPlugin({
            tsconfig: path.resolve(__dirname, 'tsconfig.renderer.json'),
            directTemplateLoading: true,
            jitMode: true,
            emitClassMetadata: false,
            emitNgModuleScope: false,
        }),
    ],
}
