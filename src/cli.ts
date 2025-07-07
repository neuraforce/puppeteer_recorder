#!/usr/bin/env node

/**
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

const args = process.argv.slice(2);

// Parse optional flags
const saveDomIndex = args.indexOf('--save_dom');
const saveDom = saveDomIndex !== -1;
if (saveDom) {
  args.splice(saveDomIndex, 1);
}

const fileNameIndex = args.indexOf('--output');
let outputFile = null;
if (fileNameIndex !== -1) {
  if (fileNameIndex === args.length - 1) {
    throw new Error('Filename required when passing --output.');
  }
  outputFile = args[fileNameIndex + 1];
  args.splice(fileNameIndex, 2);
}

const url = args[0];

if (!url) {
  console.error('url required.');
  process.exit(1);
} else {
  require('./recorder')
    .default(url, { saveDom })
    .then((output) => {
      output.pipe(process.stdout);

      if (outputFile) {
        output.pipe(require('fs').createWriteStream(outputFile, {}));
      }
    });
}
