/* eslint-disable max-len */
/** ************************************************************************************************
*   Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                             *
*   SPDX-License-Identifier: Apache-2.0                                                            *
 ************************************************************************************************ */

const { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const customSdkConfig = require('sdk-config/customSdkConfig');
const qnabot = require('qnabot/logging');
const _ = require('lodash');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { signUrls } = require('../signS3URL');
const llm = require('../llm');
const { sanitize, escapeHashMarkdown } = require('../sanitizeOutput');

const region = process.env.AWS_REGION || 'us-east-1';
const inferenceKeys = ['maxTokens', 'stopSequences', 'temperature', 'topP'];
const client = new BedrockAgentRuntimeClient(customSdkConfig('C41', { region }));

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function getSchoolInfo(schoolId) {
    const params = {
        TableName: process.env.DYNAMODB_SCHOOLTABLE,
        Key: {
            schoolId,
        },
    };

    try {
        const response = await docClient.send(new GetCommand(params));
        // Log the raw response for debugging
        qnabot.log('DynamoDB Response:', JSON.stringify(response, null, 2));

        if (!response.Item) {
            throw new Error(`No school found with ID: ${schoolId}`);
        }
        return response.Item;
    } catch (error) {
        // qnabot.log(`Error retrieving school info from DynamoDB: ${error.message}`);
        qnabot.log('DynamoDB Error Details:');
        qnabot.log(`Error Name: ${error.name}`);
        qnabot.log(`Error Message: ${error.message}`);
        if (error.$response) {
            qnabot.log('Raw Response:', JSON.stringify(error.$response, null, 2));
        }
        throw error;
    }
}

// TODO: consider definitive folder (school prefix name) vs. optional subfolders (Canvas, Helpdesk)
// Also consider configuration of different common folders
// How do we know what products/subfolders each institution has signed up for?
// Also handle web crawler if needed
// 2 options: have external/internal folders as top-level vs. sub-folder of institution, or vice-versa
// Consider if structure matters more for AWS side, or customer-side for ease of upload.
function createSchoolFilter(DepartmentName, InstitutionName, Products) {
    const filters = [];
    filters.push({
        startsWith: {
            key: 'x-amz-bedrock-kb-source-uri',
            value: `s3://knowledge-bases-test-533267095411-us-east-1/${DepartmentName}/${InstitutionName}/External`,
        },
    });

    if (Products) {
        qnabot.log('Products exist, trying to Parse');
        const products = Products.split(',')
            .map((item) => item.trim()).filter((item) => item.length > 0);
        qnabot.log('Products parsed: ', products);
        const productFilters = products.map((product) => ({
            startsWith: {
                key: 'x-amz-bedrock-kb-source-uri',
                value: `s3://knowledge-bases-test-533267095411-us-east-1/${product}/External`,
            },
        }));

        if (productFilters.length > 0) {
            filters.push(...productFilters);
        }
    }
    return filters;
}

function isNoHitsResponse(req, response) {
    const { text } = response.output;
    const { retrievedReferences } = response.citations;
    return !retrievedReferences && llm.isNoHits(req, text);
}

async function generateResponse(input, res) {
    qnabot.log(`Bedrock Knowledge Base Input: ${JSON.stringify(input, null, 2)}`);

    const response = await client.send(new RetrieveAndGenerateCommand(input));

    const { sessionId } = response;
    if (res._userInfo.knowledgeBaseSessionId !== sessionId) {
        qnabot.debug(`Saving sessionId: ${sessionId}`);
        res._userInfo.knowledgeBaseSessionId = sessionId;
    }
    return response;
}

async function generateSourceLinks(urls, KNOWLEDGE_BASE_S3_SIGNED_URL_EXPIRE_SECS) {
    const urlArr = Array.from(urls);
    const signedUrls = await signUrls(urlArr, KNOWLEDGE_BASE_S3_SIGNED_URL_EXPIRE_SECS);
    const signedUrlArr = Array.from(signedUrls);
    qnabot.debug(`signedUrls: ${JSON.stringify(signedUrlArr)}`);
    const urlListMarkdown = signedUrlArr.map((url, i) => {
        let label = urlArr[i].split('/').pop();
        if (!label) { // Handle crawled URLs ending with a slash
            label = url.split('/').slice(-2, -1)[0];
        }
        const link = `<span translate=no>[${label}](${url})</span>`;
        return link;
    });

    return { signedUrlArr, urlListMarkdown };
}
async function createHit(req, response) {
    const KNOWLEDGE_BASE_S3_SIGNED_URL_EXPIRE_SECS = _.get(req._settings, 'KNOWLEDGE_BASE_S3_SIGNED_URL_EXPIRE_SECS', 300);
    const KNOWLEDGE_BASE_S3_SIGNED_URLS = _.get(req._settings, 'KNOWLEDGE_BASE_S3_SIGNED_URLS', true);
    const KNOWLEDGE_BASE_SHOW_REFERENCES = _.get(req._settings, 'KNOWLEDGE_BASE_SHOW_REFERENCES');
    const KNOWLEDGE_BASE_PREFIX_MESSAGE = _.get(req._settings, 'KNOWLEDGE_BASE_PREFIX_MESSAGE');
    const helpfulLinksMsg = 'Source Link';
    const generatedText = sanitize(response.output.text);
    let plainText = generatedText;
    let markdown = generatedText;
    const ssml = `<speak> ${generatedText} </speak>`;
    if (KNOWLEDGE_BASE_PREFIX_MESSAGE) {
        plainText = `${KNOWLEDGE_BASE_PREFIX_MESSAGE}\n\n${plainText}`;
        markdown = `**${KNOWLEDGE_BASE_PREFIX_MESSAGE}**\n\n${markdown}`;
    }

    const { plainTextCitations, markdownCitations, urls } = processCitations(response);

    if (KNOWLEDGE_BASE_SHOW_REFERENCES) {
        plainText += plainTextCitations;
        markdown = markdownCitations
            ? `\n${markdown}\n\n<details>
            <summary>Context</summary>
            <p style="white-space: pre-line;">${markdownCitations}</p>
            </details>
            <br>`
            : markdown;
    }

    if (KNOWLEDGE_BASE_S3_SIGNED_URLS && urls.size !== 0) {
        const { signedUrlArr, urlListMarkdown } = await generateSourceLinks(urls, KNOWLEDGE_BASE_S3_SIGNED_URL_EXPIRE_SECS);

        plainText += `\n\n  ${helpfulLinksMsg}: ${signedUrlArr.join(', ')}`;
        markdown += `\n\n  ${helpfulLinksMsg}: ${urlListMarkdown.join(', ')}`;
    }

    const hit = {
        a: plainText,
        alt: {
            markdown,
            ssml,
        },
        type: 'text',
        answersource: 'BEDROCK KNOWLEDGE BASE',
    };

    qnabot.log(`Returned hit from Bedrock Knowledge Base: ${JSON.stringify(hit)}`);
    return hit;
}

function processCitations(response) {
    const urls = new Set();

    let plainTextCitations = '';
    let markdownCitations = '';

    response.citations.forEach((citation) => {
        citation.retrievedReferences.forEach((reference) => {
            markdownCitations += '\n\n';
            markdownCitations += '***';
            markdownCitations += '\n\n <br>';
            if (reference.content.text) {
                const text = escapeHashMarkdown(reference.content.text);
                markdownCitations += `\n\n  ${text}`;
                plainTextCitations += `\n\n  ${text}`;
            }

            if (reference.location) {
                const { type, s3Location, webLocation } = reference.location;

                if (type === 'S3' && s3Location?.uri) {
                    const { uri } = reference.location.s3Location;
                    urls.add(uri);
                }

                if (type === 'WEB' && webLocation?.url) {
                    const { url } = reference.location.webLocation;
                    urls.add(url);
                }
            }
        });
    });
    return { plainTextCitations, markdownCitations, urls };
}

async function processRequest(req) {
    const {
        // KNOWLEDGE_BASE_ID,
        KNOWLEDGE_BASE_MODEL_ID,
        KNOWLEDGE_BASE_KMS,
        KNOWLEDGE_BASE_PROMPT_TEMPLATE,
        KNOWLEDGE_BASE_MAX_NUMBER_OF_RETRIEVED_RESULTS,
        KNOWLEDGE_BASE_SEARCH_TYPE,
        // KNOWLEDGE_BASE_METADATA_FILTERS,
        KNOWLEDGE_BASE_MODEL_PARAMS,
        BEDROCK_GUARDRAIL_IDENTIFIER,
        BEDROCK_GUARDRAIL_VERSION,
    } = req._settings;

    // Get schoolId from session attributes
    // const schoolId = _.get(req, 'session.schoolId');
    // if (!schoolId) {
    //     throw new Error('School ID not found in session attributes');
    // }

    // Retrieve school info from DynamoDB
    // const schoolInfo = await getSchoolInfo(schoolId);
    qnabot.log('Made it to right before getting session attributes.');
    // Use the retrieved information from Connect flow's session attributes.
    const KNOWLEDGE_BASE_ID = _.get(req, 'session.KNOWLEDGE_BASE_ID');
    // const KB_FILTERS = _.get(req, 'session.KB_FILTERS');
    const InstitutionName = _.get(req, 'session.InstitutionName');
    const DepartmentName = _.get(req, 'session.DepartmentName');
    const Products = _.get(req, 'session.Products');
    qnabot.log('KB ID: ', KNOWLEDGE_BASE_ID);
    qnabot.log('Names and Products: ', InstitutionName, DepartmentName, Products);
    // Create filter based on school info
    const filters = createSchoolFilter(DepartmentName, InstitutionName, Products);

    const finalFilter = {
        orAll: filters,
    };

    const KNOWLEDGE_BASE_METADATA_FILTERS = JSON.stringify(finalFilter);
    qnabot.log(`KNOWLEDGE_BASE_ID: ${KNOWLEDGE_BASE_ID}`);
    qnabot.log(`KNOWLEDGE_BASE_METADATA_FILTER: ${KNOWLEDGE_BASE_METADATA_FILTERS}`);

    const modelArn = `arn:aws:bedrock:${region}::foundation-model/${KNOWLEDGE_BASE_MODEL_ID}`;
    let { question } = req;
    question = question.slice(0, 1000); // No more than 1000 characters - for bedrock query compatibility

    const sessionConfiguration = KNOWLEDGE_BASE_KMS ? { kmsKeyArn: KNOWLEDGE_BASE_KMS } : undefined;
    const promptTemplate = KNOWLEDGE_BASE_PROMPT_TEMPLATE.trim() ? { textPromptTemplate: KNOWLEDGE_BASE_PROMPT_TEMPLATE } : undefined;
    const guardrailId = BEDROCK_GUARDRAIL_IDENTIFIER.trim();
    const guardrailVersion = BEDROCK_GUARDRAIL_VERSION.toString();

    const vectorSearchConfigurationProps = {
        ...(KNOWLEDGE_BASE_MAX_NUMBER_OF_RETRIEVED_RESULTS !== '' && { numberOfResults: KNOWLEDGE_BASE_MAX_NUMBER_OF_RETRIEVED_RESULTS }),
        ...(KNOWLEDGE_BASE_SEARCH_TYPE !== 'DEFAULT' && { overrideSearchType: KNOWLEDGE_BASE_SEARCH_TYPE }),
        ...(KNOWLEDGE_BASE_METADATA_FILTERS !== '{}' && { filter: JSON.parse(KNOWLEDGE_BASE_METADATA_FILTERS) }),
    };

    const modelParams = JSON.parse(KNOWLEDGE_BASE_MODEL_PARAMS);
    const textInferenceConfig = _.pick(modelParams, inferenceKeys);
    const additionalModelRequestFields = _.omit(modelParams, inferenceKeys);

    const generationConfiguration = {};

    if (promptTemplate) {
        generationConfiguration.promptTemplate = promptTemplate;
    }

    if (Object.keys(textInferenceConfig).length !== 0) {
        generationConfiguration.inferenceConfig = { textInferenceConfig };
    }

    if (Object.keys(additionalModelRequestFields).length !== 0) {
        generationConfiguration.additionalModelRequestFields = additionalModelRequestFields;
    }

    if (guardrailId && guardrailVersion) {
        generationConfiguration.guardrailConfiguration = { guardrailId, guardrailVersion };
    }

    const retrievalConfiguration = {
        ...(Object.keys(vectorSearchConfigurationProps).length > 0 && { vectorSearchConfiguration: vectorSearchConfigurationProps }),
    };

    const retrieveAndGenerateInput = {
        input: {
            text: question,
        },
        retrieveAndGenerateConfiguration: {
            type: 'KNOWLEDGE_BASE',
            knowledgeBaseConfiguration: {
                knowledgeBaseId: KNOWLEDGE_BASE_ID,
                modelArn,
                ...(Object.keys(retrievalConfiguration).length > 0 && { retrievalConfiguration }),
                ...(Object.keys(generationConfiguration).length > 0 && { generationConfiguration }),
            },
        },
        ...(sessionConfiguration && { sessionConfiguration }),
    };

    qnabot.log(`Using Bedrock Knowledge Base Id: ${KNOWLEDGE_BASE_ID} and Model Id: ${KNOWLEDGE_BASE_MODEL_ID}`);
    return retrieveAndGenerateInput;
}

async function bedrockRetrieveAndGenerate(req, res) {
    let response; let
        retrieveAndGenerateSessionInput;
    const retrieveAndGenerateInput = await processRequest(req);
    let retries = 0;

    try {
        const sessionId = res._userInfo.knowledgeBaseSessionId;
        qnabot.log(`Bedrock Knowledge Base SessionId: ${sessionId}`);
        if (sessionId) {
            retrieveAndGenerateSessionInput = {
                ...retrieveAndGenerateInput,
                sessionId,
            };
            response = await generateResponse(retrieveAndGenerateSessionInput, res);
        } else {
            response = await generateResponse(retrieveAndGenerateInput, res);
        }
    } catch (e) {
        if (retries < 3 && (e.name === 'ValidationException' || e.name === 'ConflictException')) {
            retries += 1;
            qnabot.log(`Retrying to due ${e.name}...tries left ${3 - retries}`);
            response = await generateResponse(retrieveAndGenerateInput, res);
        } else {
            qnabot.log(`Bedrock Knowledge Base ${e.name}: ${e.message.substring(0, 500)}`);
            throw e;
        }
    }

    qnabot.log(`Bedrock Knowledge Base Response: ${JSON.stringify(response)}`);

    const { guardrailAction } = response;
    if (guardrailAction) {
        qnabot.log(`Guardrail Action in Bedrock Knowledge Base Response: ${guardrailAction}`);
    }

    if (isNoHitsResponse(req, response)) {
        qnabot.log('No hits from knowledge base.');
        return [res, undefined];
    }

    const hit = await createHit(req, response);

    // we got a hit, let's update the session parameters
    _.set(res, 'session.qnabot_gotanswer', true);
    res.got_hits = 1;

    return [res, hit];
}

exports.bedrockRetrieveAndGenerate = bedrockRetrieveAndGenerate;
