import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
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

const hubBaseUrl = "https://opendata-geospatialdenver.hub.arcgis.com";
const denverOrgId = "zdB7qR0BtYrg0Xpl";
const dataDirectory = path.join(__dirname, "..", "data");
const dryRun = process.env.DRY_RUN === "true";
const maxDatasets = process.env.MAX_DATASETS ? parseInt(process.env.MAX_DATASETS, 10) : undefined;
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

interface Dataset {
	id: string;
	name: string;
	itemId: string;
	hubType: string;
	content: string;
}

const startDate = new Date();

(async () => {
	async function getAllDatasets(): Promise<Dataset[]> {
		const datasets: Dataset[] = [];
		let pageNumber = 1;
		const pageSize = 100;

		while (true) {
			const apiUrl = `${hubBaseUrl}/api/v3/datasets?filter[orgId]=${denverOrgId}&filter[downloadable]=true&page[size]=${pageSize}&page[number]=${pageNumber}&fields[datasets]=slug,name,downloadable,content,hubType,itemId`;
			const response = (await axiosGetRetry(apiUrl, 5)).data;

			for (const item of response.data) {
				datasets.push({
					id: item.id,
					name: item.attributes.name,
					itemId: item.attributes.itemId,
					hubType: item.attributes.hubType,
					content: item.attributes.content,
				});
			}

			if (response.meta.page.nextStart === -1 || response.data.length === 0) break;
			pageNumber++;
			await timeout(500);
		}

		return datasets;
	}

	const useLocalDataSet = false;
	const tmpDatasetsFile = path.join(__dirname, "..", "tmp", "datasets.json");
	const datasets: Dataset[] = useLocalDataSet ? JSON.parse(await fs.promises.readFile(tmpDatasetsFile, "utf8")) : await getAllDatasets();
	await mkdirp(path.join(__dirname, "..", "tmp"));
	await fs.promises.writeFile(tmpDatasetsFile, JSON.stringify(datasets));
	console.log(`[${Date.now()}] ${datasets.length} datasets found.\n\n`);

	const status = {
		"success": 0,
		"skipped": 0,
		"pending": 0,
		"errorDownloadingFile": 0
	};

	function sanitizeFileName(name: string): string {
		return name.replace(/[/\\?%*:|"<>]/g, "-").trim();
	}

	function getFileExtension(dataset: Dataset): string | null {
		if (dataset.content === "Feature Service") return ".csv";
		const typeMap: Record<string, string> = {
			"CSV": ".csv",
			"CSV Collection": ".csv",
			"GeoJSON": ".geojson",
			"GeoJson": ".geojson",
			"KML": ".kml",
			"KML Collection": ".kml",
			"Shapefile": ".zip",
			"PDF": ".pdf",
			"Microsoft Excel": ".xlsx",
		};
		return typeMap[dataset.hubType] ?? typeMap[dataset.content] ?? null;
	}

	async function getFeatureServiceDownloadUrl(dataset: Dataset): Promise<string | null> {
		const layerMatch = dataset.id.match(/_(\d+)$/);
		const layerIndex = layerMatch ? layerMatch[1] : "0";
		const apiUrl = `${hubBaseUrl}/api/download/v1/items/${dataset.itemId}/csv?layers=${layerIndex}&redirect=false`;

		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const response = await axiosGetRetry(apiUrl);
				if (response.data.status === "Completed" && response.data.resultUrl) {
					return response.data.resultUrl;
				} else if (response.data.status === "Pending") {
					await timeout(10000);
				} else {
					return null;
				}
			} catch {
				return null;
			}
		}
		return null;
	}

	async function downloadDataset(dataset: Dataset): Promise<void> {
		const extension = getFileExtension(dataset);
		if (!extension) {
			status.skipped++;
			return;
		}

		const safeName = sanitizeFileName(dataset.name);
		const dir = path.join(dataDirectory, safeName);

		try {
			let downloadUrl: string | null = null;

			if (dataset.content === "Feature Service") {
				downloadUrl = await getFeatureServiceDownloadUrl(dataset);
			} else {
				downloadUrl = `https://www.arcgis.com/sharing/rest/content/items/${dataset.itemId}/data`;
			}

			if (!downloadUrl) {
				console.warn(`Could not get download URL for: ${dataset.name} (${dataset.id})`);
				status.pending++;
				return;
			}

			await mkdirp(dir);
			const filePath = path.join(dir, `${safeName}${extension}`);

			const stream = await axiosRetry({
				"method": "GET",
				"url": downloadUrl,
				"responseType": "stream"
			}, 3);

			await new Promise<void>((resolve, reject) => {
				const writeStream = fs.createWriteStream(filePath);
				stream.data.pipe(writeStream);
				writeStream.on("finish", resolve);
				writeStream.on("error", reject);
			});

			status.success++;
		} catch (error) {
			console.error(`Error downloading dataset: ${dataset.name} (${dataset.id})`);
			status.errorDownloadingFile++;
		}
	}

	const datasetsToProcess = maxDatasets ? datasets.slice(0, maxDatasets) : datasets;
	if (maxDatasets) {
		console.log(`[${Date.now()}] Limiting to ${datasetsToProcess.length} datasets (MAX_DATASETS=${maxDatasets}).`);
	}

	await AsyncThrottle(datasetsToProcess, downloadDataset, { "concurrency": 5 });

	console.log(`[${Date.now()}] Completed downloading.`);
	console.log(`\n\n---\n\n`);
	console.log("Success:", status.success);
	console.log("Skipped (unsupported type):", status.skipped);
	console.log("Pending (timed out):", status.pending);
	console.log("Error downloading:", status.errorDownloadingFile);

	if (dryRun) {
		console.log(`\n[${Date.now()}] DRY_RUN=true — skipping S3 upload.`);
		return;
	}

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
