import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import cheerio from "cheerio";
import * as url from "url";
import * as util from "util";
import * as path from "path";
import * as fs from "fs";
import { mkdirp } from "mkdirp";
import AsyncThrottle from "./AsyncThrottle";
const timeout = util.promisify(setTimeout);
import * as crypto from "crypto";

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

console.log(`[${Date.now()}] Starting...`);

const packageJSON = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

const rootDomain = "https://www.denvergov.org";
const initialURL = `${rootDomain}/opendata/search`;
const dataDirectory = path.join(__dirname, "..", "data");
const axiosInstance = axios.create({
	"headers": {
		"User-Agent": `DenverOpenDataArchiveScraper/${packageJSON.version} (https://github.com/fishcharlie/DenverOpenData)`,
	}
});

function axiosGetRetry(url: string, retries: number = 3): Promise<AxiosResponse<any, any>> {
	return axiosInstance
		.get(url)
		.catch(async (error) => {
			if (retries > 0) {
				await timeout(2000);
				console.log("Retrying " + url);
				return axiosGetRetry(url, retries - 1);
			}
			throw error;
		});
}
function axiosRetry(config: AxiosRequestConfig<any>, retries: number = 3): Promise<AxiosResponse<any, any>> {
	return axiosInstance(config)
		.catch(async (error) => {
			if (retries > 0) {
				await timeout(2000);
				return axiosRetry(config, retries - 1);
			}
			throw error;
		});
}

const startDate = new Date();

(async () => {
	async function getDataSets(initialURL: string, previouslyCrawledURLs: Set<string> = new Set()): Promise<Set<string>> {
		const datasets: Set<string> = new Set();

		const dataSetsPage = (await axiosGetRetry(initialURL, 5)).data;
		previouslyCrawledURLs.add(initialURL);
		const $ = cheerio.load(dataSetsPage);

		$("div.results div.result div.result-title a").map((i, el) => {
			const url = $(el).attr("href");
			if (url) {
				datasets.add(url);
			}
		});

		const nextURLPath = $("div.pager-container > div.pager > a:last-of-type").attr("href");
		if (nextURLPath) {
			const nextURL = new url.URL(nextURLPath, initialURL).toString();

			if (nextURL && !previouslyCrawledURLs.has(nextURL)) {
				await timeout(1000);
				const nextDataSets = await getDataSets(new url.URL(nextURL, initialURL).toString(), previouslyCrawledURLs);
				nextDataSets.forEach(dataset => datasets.add(dataset));
			}
		}

		return datasets;
	}
	const useLocalDataSet = false;
	const tmpDatasetsFile = path.join(__dirname, "..", "tmp", "datasets.json");
	const datasets: Set<string> = useLocalDataSet ? new Set(JSON.parse(await fs.promises.readFile(tmpDatasetsFile, "utf8"))) : await getDataSets(initialURL);
	await mkdirp(path.join(__dirname, "..", "tmp"));
	await fs.promises.writeFile(tmpDatasetsFile, JSON.stringify([...datasets]));
	console.log(`[${Date.now()}] ${datasets.size} datasets found.\n\n`);

	const status = {
		"success": 0,
		"noDescription": 0,
		"noTitle": 0,
		"linkNotFound": 0,
		"noFileFound": 0,
		"errorDownloadingFile": 0
	};
	const validTypes = ["csv", "json", "pdf"];
	function getDataFile(link: string, name: string, datasetURL: string, saveDirectory: string): Promise<void> {
		return new Promise<void>(async (resolve) => {
			try {
				const stream = await axiosRetry({
					"method": "GET",
					"url": link,
					"responseType": "stream"
				}, 3);
				const linkExtension = path.extname(link);
				stream.data.pipe(fs.createWriteStream(path.join(saveDirectory, `${name}${linkExtension}`)));
				stream.data.on("end", () => {
					status.success++;
					return resolve();
				});
			} catch (error) {
				console.error(`Error downloading file (${link}) for ${datasetURL}`);
				status.errorDownloadingFile++;
				return resolve();
			}
		});
	}
	function getDataFiles(pathString: string): Promise<void> {
		return new Promise(async (resolve) => {
			const datasetURL = `${rootDomain}${pathString}`;
			const datasetPage = (await axiosGetRetry(datasetURL, 3)).data;
			const $ = cheerio.load(datasetPage);
			const title = $("h2.package-title").text();
			if (!title) {
				console.error(`No title found for ${datasetURL}`);
				status.noTitle++;
				return resolve();
			}
			const linkCSSSelector = "td a[data-action=Download],a[data-action=Open]";
			const tr = $("div.container table tbody tr").filter((i, el): boolean => {
				const $el = $(el);
				const formatText = $el.find("td span.format").text();
				const link = $el.find(linkCSSSelector).attr("href");
				if (formatText && link) {
					const format = validTypes.find((type) => formatText.toLowerCase() === type);
					return Boolean(format) && link.endsWith(`.${format}`);
				} else {
					return false;
				}
			});

			if (tr.length >= 1) {
				const trLength = tr.length;
				for (let i = 0; i < trLength; i++) {
					const $tr = tr.eq(i);
					const description = $tr.find("td:first-child").text().trim();
					if (!description) {
						console.error(`No description found for ${datasetURL}`);
						status.noDescription++;
						break;
					} else {
						const link = $tr.find(linkCSSSelector).attr("href");
						if (link) {
							const dir = path.join(dataDirectory, title);
							await mkdirp(dir);
							await getDataFile(link, description, datasetURL, dir);
						} else {
							console.error(`Link not found for ${datasetURL}`);
							status.linkNotFound++;
							break;
						}
					}
				}
			} else {
				console.warn(`No file found for ${datasetURL}`);
				status.noFileFound++;
			}
			return resolve();
		});
	}
	const results = await AsyncThrottle([...datasets], getDataFiles, {
		"concurrency": 5
	});
	console.log(`[${Date.now()}] Completed downloading.`);
	console.log(`\n\n---\n\n`);
	console.log("Success:", status.success);
	console.log("No description:", status.noDescription);
	console.log("No title:", status.noTitle);
	console.log("Link not found:", status.linkNotFound);
	console.log("No file found:", status.noFileFound);
	console.log("Error downloading file:", status.errorDownloadingFile);

	// Recursively get all files in dataDirectory
	const allFiles = getFilesRecursively(dataDirectory).map((file) => {
		const hash = crypto.createHash("sha512");
		hash.update(fs.readFileSync(file));

		return {
			"file": file,
			"hash": hash.digest("hex")
		};
	});

	console.log(`[${Date.now()}] Got all files.`);

	const endpoint = process.env.S3_ENDPOINT;
	const bucket = process.env.S3_BUCKET;

	const s3Client = new S3Client({
		"endpoint": endpoint
	});
	console.log("S3 client created");
	console.log(`Endpoint: ${endpoint}`);
	console.log(`Bucket: ${bucket}`);
	for (const file of allFiles) {
		const filePathParts = file.file.split(path.sep);
		const lastTwoParts = filePathParts.slice(filePathParts.length - 2);

		const hashKey = `${lastTwoParts[0]}/.${lastTwoParts[1].split(".")[0]}.sha512`
		const urlSafeHashKey = hashKey;

		const key = `${lastTwoParts[0]}/${formatDate(startDate)}/${lastTwoParts[1]}`;
		const urlSafeKey = key;

		console.log(file);

		console.log("hashKey", hashKey);
		console.log("urlSafeHashKey", urlSafeHashKey);

		console.log("key", key);
		console.log("urlSafeKey", urlSafeKey);

		console.log("\n");

		let remoteHash;
		try {
			console.log("Getting remote hash");
			remoteHash = await (await s3Client.send(new GetObjectCommand({
				"Bucket": bucket,
				"Key": urlSafeHashKey
			}))).Body?.transformToString();
			console.log(`Got remote hash: ${remoteHash}`);
		} catch (e) {
			// no-op
		}

		if (remoteHash !== file.hash) {
			console.log(`[${Date.now()}] Uploading ${file.file}`);
			await s3Client.send(new PutObjectCommand({
				"Bucket": bucket,
				"Key": urlSafeKey,
				"Body": fs.createReadStream(file.file),
				"ACL": "public-read"
			}));
			console.log(`[${Date.now()}] Uploading hash ${file.file}`);
			await s3Client.send(new PutObjectCommand({
				"Bucket": bucket,
				"Key": urlSafeHashKey,
				"Body": file.hash,
				"ACL": "public-read"
			}));
			console.log(`[${Date.now()}] Uploaded ${file.file}`);
		} else {
			console.log(`[${Date.now()}] Skipping ${file.file}. No updates.`);
		}
	}
})();

function getFilesRecursively(directory: string): string[] {
	let results: string[] = [];

	const files = fs.readdirSync(directory);

	for (const file of files) {
		const filePath = path.join(directory, file);
		const stat = fs.statSync(filePath);

		if (stat.isDirectory()) {
			results = results.concat(getFilesRecursively(filePath));
		} else {
			results.push(filePath);
		}
	}

	return results;
}

function formatDate(date: Date | string) {
	var d = new Date(date),
		month = '' + (d.getUTCMonth() + 1),
		day = '' + d.getUTCDate(),
		year = d.getUTCFullYear();

	if (month.length < 2)
		month = '0' + month;
	if (day.length < 2)
		day = '0' + day;

	return [year, month, day].join('-');
}
