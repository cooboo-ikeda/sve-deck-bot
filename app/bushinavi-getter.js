import puppeteer, { ExtensionTransport } from 'puppeteer';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import fs from 'fs'; // ファイル操作用モジュールをインポート

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');

const getLastWeekDates = () => {
    const lastWeekMonday = dayjs().tz().startOf('week').subtract(1, 'week').add(1, 'day');
    const lastWeekSunday = dayjs().tz().endOf('week').subtract(1, 'week').add(1, 'day');
    return { lastWeekMonday, lastWeekSunday };
};

const launchBrowser = async () => {
    return await puppeteer.launch({
        executablePath: '/usr/bin/chromium-browser',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080'
        ]
    });
};

const getEventIds = async (page, browser) => {
    const event_ids = [];
    const eventPromises = [];

    console.log('Waiting for event list to load');
    page.on('response', async (response) => {
        const request = response.request();
        if (request.url().includes('/event/result/list') && response.request().method() === 'GET') {
            try {
                console.log('Received event list response');
                const data = await response.json();
                data.success.events.forEach(event => {
                    event_ids.push(event.event_id);
                });
                console.log(`Found ${event_ids.length} events`);
                event_ids.forEach(event_id => {
                    console.log(`Processing event: ${event_id}`);
                    const eventPromise = processEvent(browser, event_id);
                    eventPromises.push(eventPromise);
                });
            } catch (error) {
                console.error('Failed to load response body:', error);
            }
        }
    });

    await page.waitForSelector('.btn-to-detail', { timeout: 3600000 }); // タイムアウトを1時間に設定
    console.log('Event list loaded, waiting for all events to be processed...');
    await Promise.all(eventPromises);
    console.log('All events processed');
};

const processEvent = async (browser, event_id) => {
    console.log(`Opening event result page for event_id: ${event_id}`);
    const resultPage = await browser.newPage();
    resultPage.setDefaultNavigationTimeout(3600000);
    const deckPromises = [];
    const responsePromises = [];

    resultPage.on('response', async (resultResponse) => {
        const resultRequest = resultResponse.request();
        if (resultRequest.url().includes('/api/user/event/result/detail/') && resultRequest.method() === 'GET') {
            const responsePromise = (async () => {
                try {
                    if (resultResponse.headers()['content-type'].includes('application/json')) {
                        console.log(`Received event detail JSON for event_id: ${event_id}`);
                        const eventData = await resultResponse.json();
                        const rankings = Object.values(eventData.success.grouped_rankings['']).sort((a, b) => a.rank - b.rank);
                        const totalParticipants = eventData.success.joined_player_count;
                        let maxRank = 8;
                        if (totalParticipants <= 16) {
                            maxRank = 4;
                        }
                        if (totalParticipants < 8) {
                            maxRank = 1;
                        }
                        console.log(`Event ${event_id}: totalParticipants=${totalParticipants}, maxRank=${maxRank}`);
                        const filteredRankings = rankings.filter(ranking => ranking.rank <= maxRank);

                        const teamMembersByRank = filteredRankings.reduce((acc, ranking) => {
                            acc[ranking.rank] = ranking.team_member;
                            return acc;
                        }, {});
                        console.log(`Filtered team members for event ${event_id} (up to rank ${maxRank}):`, teamMembersByRank);

                        Object.keys(teamMembersByRank).forEach(rank => {
                            teamMembersByRank[rank].forEach(member => {
                                console.log(`Processing deck for event ${event_id}, rank ${rank}, player ${member.player_name}`);
                                const deckPromise = processDeck(browser, member.deck_recipe_id, member.player_name, rank);
                                deckPromises.push(deckPromise);
                            });
                        });
                    } else {
                        console.error('Response is not JSON:', await resultResponse.text());
                    }
                } catch (error) {
                    console.error('Failed to load AJAX response body:', error);
                }
            })();
            responsePromises.push(responsePromise);
        }
    });

    await resultPage.goto(`https://www.bushi-navi.com/event/result/${event_id}`);
    console.log(`Navigated to event result page for event_id: ${event_id}`);
    await resultPage.waitForSelector('.showDeckButton', { timeout: 3600000 });
    console.log(`Deck buttons loaded for event_id: ${event_id}`);
    await Promise.all(responsePromises);
    console.log(`All event detail responses processed for event_id: ${event_id}`);
    await Promise.all(deckPromises);
    console.log(`All decks processed for event_id: ${event_id}`);
    await resultPage.close();
    console.log(`Closed result page for event_id: ${event_id}`);
};

const allDecks = []; // すべてのデッキ情報を格納する配列

const processDeck = async (browser, deck_id, user_name, rank, retryCount = 0) => {
    if (!deck_id) {
        console.warn(`Skipped processing: deck_id is undefined for user: ${user_name}, rank: ${rank}`);
        return;
    }
    console.log(`Opening deck page for deck_id: ${deck_id}, user: ${user_name}, rank: ${rank}, retry: ${retryCount}`);
    const deckPage = await browser.newPage();
    deckPage.setDefaultNavigationTimeout(3600000);
    const responsePromises = [];

    deckPage.on('response', async (deckResponse) => {
        const deckRequest = deckResponse.request();
        if (deckRequest.url().includes('/app/api/view') && deckRequest.method() === 'POST') {
            const responsePromise = (async () => {
                try {
                    if (deckResponse.headers()['content-type'].includes('application/json')) {
                        const deckData = await deckResponse.json();

                        const simplifiedDeck = {
                            deck_id: deckData.deck_id,
                            class_name: deckData.deck_param2,
                            user_name: user_name,
                            rank: rank,
                            cards: Array.isArray(deckData.list)
                                ? deckData.list.map(card => ({
                                    card_name: card.name,
                                    card_id: card.card_number,
                                    count: card.num
                                }))
                                : []
                        };
                        allDecks.push(simplifiedDeck);
                        console.log(`Deck processed: ${simplifiedDeck.deck_id} by ${user_name} (Rank: ${rank})`);
                    } else {
                        console.error('Response is not JSON:', await deckResponse.text());
                    }
                } catch (error) {
                    console.error('Failed to load AJAX response body:', error);
                    // リトライ処理
                    if (retryCount < 3) {
                        console.log(`Retrying deck page for deck_id: ${deck_id} (retry ${retryCount + 1})`);
                        await deckPage.reload({ waitUntil: 'networkidle0' });
                        await processDeck(browser, deck_id, user_name, rank, retryCount + 1);
                    } else {
                        console.error(`Failed to process deck_id: ${deck_id} after 3 retries.`);
                    }
                }
            })();
            responsePromises.push(responsePromise);
        }
    });

    await deckPage.goto(`https://decklog.bushiroad.com/view/${deck_id}`);
    console.log(`Navigated to deck page for deck_id: ${deck_id}`);
    try {
        await deckPage.waitForSelector('.card-detail', { timeout: 60000 });
        console.log(`Deck details loaded for deck_id: ${deck_id}`);
    } catch (e) {
        console.error(`Timeout: .card-detail not found for deck_id: ${deck_id}`);
        // タイムアウト時もリトライ
        if (retryCount < 3) {
            console.log(`Retrying deck page for deck_id: ${deck_id} due to timeout (retry ${retryCount + 1})`);
            await deckPage.reload({ waitUntil: 'networkidle0' });
            await processDeck(browser, deck_id, user_name, rank, retryCount + 1);
            await deckPage.close();
            return;
        } else {
            console.error(`Failed to process deck_id: ${deck_id} after 3 retries (timeout).`);
        }
    }
    await Promise.all(responsePromises);
    console.log(`All deck responses processed for deck_id: ${deck_id}`);
    await deckPage.close();
    console.log(`Closed deck page for deck_id: ${deck_id}`);
};

(async () => {
    console.log(dayjs().tz().format('YYYY-MM-DD'));
    const { lastWeekMonday, lastWeekSunday } = getLastWeekDates();
    const url = `https://www.bushi-navi.com/event/result/list?game_title_id[]=6&limit=500&offset=0&series_type[]=3&end_date=${lastWeekSunday.tz().format('YYYY-MM-DD')}&start_date=${lastWeekMonday.tz().format('YYYY-MM-DD')}`;
    const browser = await launchBrowser();
    console.log('Browser launched');
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(3600000);
    console.log('New page created');
    await page.goto(url);
    console.log('Navigated to event list page');

    await getEventIds(page, browser);

    const debugMode = process.argv.includes('--debug');
    const outputPostJson = process.argv.includes('--output-post-json'); // 追加: 引数で制御

    if (outputPostJson) {
        const postJsonPath = './post_decks.json';
        try {
            fs.writeFileSync(postJsonPath, JSON.stringify(allDecks, null, 2), 'utf-8');
            console.log(`POST用データを ${postJsonPath} に出力しました`);
        } catch (error) {
            console.error('POST用データのファイル出力に失敗:', error);
        }
    }

    if (debugMode) {
        const filePath = './debug_decks.json';
        try {
            fs.writeFileSync(filePath, JSON.stringify(allDecks, null, 2), 'utf-8');
            console.log(`Deck data has been written to ${filePath}`);
        } catch (error) {
            console.error('Failed to write deck data to file:', error);
        }
    } else {
        const postUrl = process.env.GAS_POST_URL; // 環境変数から取得
        if (!postUrl) {
            console.error('GAS_POST_URL is not set.');
            process.exit(1);
        }

        try {
            console.log('Posting all decks to Google Apps Script endpoint...');
            const postResponse = await fetch(postUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(allDecks),
            });

            if (!postResponse.ok) {
                console.error('Failed to POST all decks:', await postResponse.text());
            } else {
                console.log('Successfully POSTed all decks');
            }
        } catch (error) {
            console.error('Error during POSTing all decks:', error);
        }
    }

    await browser.close();
    console.log('Browser closed');
})();