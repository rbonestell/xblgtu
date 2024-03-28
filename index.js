#!/usr/bin/env node

import * as readline from 'node:readline/promises';
import * as axl from 'app-xbox-live'
import axios from 'axios';
import https from 'https';
import ora from 'ora';
import logSymbols from 'log-symbols';
import * as fs from 'fs';
import path from 'path'

const spinner = ora();
process.on('SIGINT', () => {
	spinner.fail();
	spinner.warn("Cancelled by user")
	process.exit(0);
});

let attemptCount = 0;
let errorCount = 0;
let authToken;
let xl;
let reservationId;

// Define settings defaults
const settings = {
	autoClaim: false,
    monitorAvailability: false,
	lookupRetryDelaySeconds: 75,
    login: "",
    password: "",
    desiredGamertag: ""
};

// Clear screen and prompt for credentials
DisplayHeader();

// Attempt to load settings from settings.json
LoadSettings();

// Prompt for login and password if not found in settings.json
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
if (!settings.login || !settings.password) {
	console.log("Please enter your Microsoft account credentials");
	console.log(`${logSymbols.warning} Not compatible with 2FA or passwordless accounts ${logSymbols.warning}\n`);
	settings.login = await rl.question('Login: ');
	settings.password = await rl.question('Password: ');
}

// Clear screen and prompt for desired gamertag
DisplayHeader();

// Prompt for desired gamertag if not found in settings.json
if (!settings.desiredGamertag) {
	settings.desiredGamertag = await rl.question(`${logSymbols.info} Desired gamertag: `);
} else {
	console.log(`${logSymbols.info} Desired gamertag: ${settings.desiredGamertag}`);
}
rl.close();

// Attempt to login
await AttemptLogin(settings.login, settings.password);

// Begin gamertag lookup
spinner.start(`Looking up gamertag ${settings.desiredGamertag}...`);
await LookupGamertag(settings.desiredGamertag);

function LoadSettings() {
	try {
		var settingsJson;
		const filePath = path.join(process.cwd(), 'settings.json');
		const data = fs.readFileSync(filePath, 'utf8');
		settingsJson = JSON.parse(data);
		settings.autoClaim = settingsJson?.autoClaim || false;
		settings.monitorAvailability = settingsJson?.monitorAvailability || false;
		settings.login = settingsJson?.login || "";
		settings.password = settingsJson?.password || "";
		settings.desiredGamertag = settingsJson?.desiredGamertag || "";
		settings.lookupRetryDelaySeconds = settingsJson?.lookupRetryDelaySeconds || 75;
		spinner.succeed('')
	} catch (err) {
		return
	}
}

function DisplayHeader() {
	console.clear(); 
	console.log("\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}")
	console.log("\u{0001F3AE} Xbox Live Gamertag Utility \u{0001F3AE}")
	console.log("\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\u{0001F3AE}\n")
	console.log("    (Press CTRL+C to Cancel)\n")
}

async function AttemptLogin(user, password) {
	try {
		spinner.start("Logging in...");
		const result = await axl.Token(user, password);
		authToken = `XBL3.0 x=${result[1]};${result[0]}`;
		xl = new axl.Account(authToken);
		const me = await xl.me.profile.get();
		reservationId = `${me.userXuid}`;
		spinner.succeed(`Successfully logged in as ${me.gamerTag}`);
	} catch (err) {
		spinner.fail(`Login failed, check credentials and try again`);
		process.exit();
	}
}

async function LookupGamertag(gamertag) {
	try {
		attemptCount++;
		const lookupResponse = await QueryGamertag(gamertag);
		errorCount = 0; // Reset request error count
		if (lookupResponse?.status == 200) {
			if (lookupResponse?.data?.composedGamertag == gamertag) {
				spinner.succeed(`Gamertag ${gamertag} is available`);
				if (settings.autoClaim)
					ClaimGamertag(gamertag);
			} else {
				if (settings.monitorAvailability) {
					spinner.start(`Gamertag ${gamertag} is unavailable, monitoring... (${attemptCount})`);
					await sleep(settings.lookupRetryDelaySeconds * 1000);
					await LookupGamertag(gamertag);
				} else {
					spinner.fail(`Gamertag ${gamertag} is unavailable`);
				}
			}
		} else if (lookupResponse?.status === 400) {
			spinner.fail(`Error code ${lookupResponse.data?.code}: ${lookupResponse.data?.description}`);
		}
	} catch (err) {
		errorCount++;
		spinner.fail("Error: " + err.message);
		if (errorCount < 10)
			await LookupGamertag(gamertag);
		else
			process.exit(1);
	}
}

async function QueryGamertag(gamertag) {
	const headers = {
		'User-agent' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
		'Accept' : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3',
        'Accept-language' : 'en-US,en;q=0.9',
        'x-xbl-contract-version': '1',
		'authorization': authToken
	};

    const requestBody = {
		gamertag: gamertag,
		reservationId: reservationId,
		targetGamertagFields: "gamertag"
	};

	try	{
		const response = await axios.post('https://gamertag.xboxlive.com/gamertags/reserve', requestBody, {
			headers: headers,
			httpAgent: new https.Agent({ rejectUnauthorized: false })
		});
		return response;
	} catch (err) {
		if (err.response)
			return err.response;
		spinner.fail("Error: " + err.message);
		return null;
	}
}

async function ClaimGamertag(desiredGamertag) {
	spinner.start(`Attempting to claim gamertag ${desiredGamertag}...`);
	const headers = {
		'User-agent' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
		'Accept' : 'application/json, text/plain, */*',
		'Accept-Language' : 'en-US,en;q=0.9',
		'x-xbl-contract-version': '6',
		'authorization': authToken
	};

    const requestBody = {
        reservationId: reservationId,
        gamertag: {
            gamertag: desiredGamertag,
            gamertagSuffix: '',
            classicGamertag: desiredGamertag
        },
        preview: false,
        useLegacyEntitlement: false
    };
	try {
		const result = await axios.post('https://accounts.xboxlive.com/users/current/profile/gamertag', requestBody, {
			headers: headers,
			httpAgent: new https.Agent({ rejectUnauthorized: false })
		});
		if (result.status === 200)
			spinner.succeed(`Successfully claimed gamertag ${desiredGamertag}! \u{0001F389}`);
		else
			spinner.fail(`Unknown error attempting to claim gamertag`);
	} catch (error) {
		// TODO: Log error to log file
		spinner.fail(`Failed to claim gamertag due to error:\n\t${error.message}`);
    };
}

function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}