import axios from 'axios';

// DeFiLlama price response interface
interface DeFiLlamaPriceResponse {
	coins: {
		[key: string]: {
			decimals: number;
			price: number;
			symbol: string;
			timestamp: number;
			confidence: number;
		};
	};
}

// DeFiLlama yields pool response interface
export interface DeFiLlamaPoolResponse {
	status: string;
	data: Array<{
		timestamp: string;
		tvlUsd: number;
		apy: number;
		apyBase: number;
		apyReward: number | null;
		il7d: number | null;
		apyBase7d: number | null;
	}>;
}

// DeFiLlama protocol response interface
export interface DeFiLlamaProtocolResponse {
	id: string;
	name: string;
	address: string;
	symbol: string;
	url: string;
	description: string;
	chain: string;
	logo: string;
	audits: string;
	audit_note: string | null;
	gecko_id: string;
	cmcId: string;
	category: string;
	chains: string[];
	module: string;
	twitter: string;
	audit_links: string[];
	github: string[];
	chainTvls: {
		[chain: string]: {
			tvl: Array<{
				date: number;
				totalLiquidityUSD: number;
			}>;
			/** @deprecated Use 'tokens' instead. Kept for backward compatibility. */
			tokensInUsd?: Array<{
				date: number;
				tokens: {
					[tokenSymbol: string]: number;
				};
			}>;
			/** New API field name (replaces tokensInUsd) */
			tokens?: Array<{
				date: number;
				tokens: {
					[tokenSymbol: string]: number;
				};
			}>;
		};
	};
	/** Top-level tokens field (new API structure - aggregated across all chains) */
	tokens?: Array<{
		date: number;
		tokens: {
			[tokenSymbol: string]: number;
		};
	}>;
	/** Top-level tokensInUsd field (alternative new API structure - aggregated across all chains) */
	tokensInUsd?: Array<{
		date: number;
		tokens: {
			[tokenSymbol: string]: number;
		};
	}>;
}

export async function getDeFiLlamaPrice(address: string, chain: string, tokenName?: string): Promise<number> {
	try {
		console.log(`\n🔍 Fetching ${tokenName} price from DeFiLlama`);

		const response = await axios.get<DeFiLlamaPriceResponse>(
			`https://coins.llama.fi/prices/current/${chain}:${address}?searchWidth=12h`
		);

		const priceData = response.data.coins[`${chain}:${address}`];
		if (!priceData) {
			console.error('No price data found in response');
			throw new Error(`No price data found for ${tokenName}`);
		}

		console.log(`✅ Successfully fetched price: $${priceData.price}`);
		return priceData.price;
	} catch (error) {
		console.error(`Error fetching price from DeFiLlama for ${tokenName}:`, error);
		throw error;
	}
}

export async function getDefiLlamaPriceByTimestamp(
	tokenAddress: string,
	blockchain: string,
	unixTimestamp: number,
	disableLogging?: boolean,
	searchBackwardsDays: number = 0
): Promise<number> {
	let currentTimestamp = unixTimestamp;
	const oneDayInSeconds = 24 * 60 * 60;
	const oldestTimestamp = unixTimestamp - searchBackwardsDays * oneDayInSeconds;

	while (currentTimestamp >= oldestTimestamp) {
		try {
			if (!disableLogging) {
				console.log(
				
						`\n🔍 Fetching historical price for ${blockchain}:${tokenAddress} at timestamp ${currentTimestamp} from DeFiLlama`
					)
				;
			}

			const url = `https://coins.llama.fi/prices/historical/${currentTimestamp}/${blockchain}:${tokenAddress}?searchWidth=4h`;
			const response = await axios.get<DeFiLlamaPriceResponse>(url);

			const priceData = response.data.coins[`${blockchain}:${tokenAddress}`];
			if (priceData && typeof priceData.price === 'number') {
				if (!disableLogging) {
					console.log(`✅ Successfully fetched historical price: $${priceData.price}`);
				}
				return priceData.price;
			}

			if (!disableLogging) {
				console.log(`No price data found at timestamp ${currentTimestamp}. Trying previous day.`);
			}
		} catch (error) {
			if (!disableLogging) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				console.warn(
					
						`Warning fetching historical price from DeFiLlama for ${blockchain}:${tokenAddress} at timestamp ${currentTimestamp}: ${errorMessage}. Trying previous day.`
				);
			}
		}

		currentTimestamp -= oneDayInSeconds;
	}

	const errorMessage = `No historical price data found for ${blockchain}:${tokenAddress} at or before timestamp ${unixTimestamp} within a ${searchBackwardsDays}-day search window.`;
	if (!disableLogging) {
		console.error(errorMessage);
	}
	throw new Error(errorMessage);
}
