import { Meteor } from 'meteor/meteor';
import { HTTP } from 'meteor/http';
import R from 'ramda';

import StripeHelper from '../../cards/server/stripe_helper';
import bugsnag from '../../bugsnag/server/bugsnag';
import CustomersCollection from '../../customers/collection';

const Subscription = {
  create(orderData) {
    if (orderData) {
      const subscriptionData = this._prepareSubscription(orderData);
      const subServiceUrl =
        `${Meteor.settings.private.subscriptions.serviceUrl}`
        + '/methods/api_CreateNewSubscription';
      HTTP.post(subServiceUrl, { data: subscriptionData }, (error) => {
        if (error) {
          throw error;
        }
      });
    }
  },

  resume(subscriptionId) {
    if (subscriptionId) {
      const subServiceUrl =
        `${Meteor.settings.private.subscriptions.serviceUrl}`
        + `/api/subscriptions/${subscriptionId}/renew`;
      const bearer = new Buffer(process.env.MP_API_KEY).toString('base64');
      HTTP.put(
        subServiceUrl,
        {
          headers: {
            authorization: `Bearer ${bearer}`,
          },
        },
        (error) => {
          if (error) {
            throw error;
          }
        }
      );
    }
  },

  _subscriptionFrequencyId: 'w1',

  _prepareSubscription(orderData) {
    const productData = this._prepareProducts(orderData);
    const customer = this._prepareCustomer(orderData);
    const shippingMethod = this._prepareShippingMethod(orderData);
    const order = this._prepareOrder(orderData);

    const subscriptionData = {
      apiKey: process.env.MP_API_KEY,
      sendSubscriptionIdToStore: true,
      includesFreeTrial: productData.includesFreeTrial,
      subscription: {
        renewalFrequencyId: this._subscriptionFrequencyId,
        shippingMethodId: shippingMethod.shippingMethodId,
        shippingMethodName: shippingMethod.shippingMethodName,
        shippingCost: shippingMethod.shippingCost,
      },
      customer,
      order,
      subscriptionItems: productData.products,
    };

    return subscriptionData;
  },

  _prepareProducts(orderData) {
    const productData = {
      products: [],
      includesFreeTrial: false,
    };
    if (orderData && orderData.line_items) {
      orderData.line_items.forEach((lineItem) => {
        if (lineItem.sku.indexOf('TF_SUB_') > -1) {
          this._subscriptionFrequencyId =
            lineItem.sku.replace('TF_SUB_', '').toLowerCase();
        } else if (lineItem.sku.indexOf('TF_TRIAL_') > -1) {
          // note_attributes format:
          // name = TF_ONGOING_TRIAL
          // value = TF_SPORT_SIZE (PRODUCT_ID-VARIATION_ID)
          orderData.note_attributes.forEach((note) => {
            if (note.name === 'TF_ONGOING_TRIAL') {
              const matches = /^TF_.*?\((.*?)-(.*?)\)/.exec(note.value);
              if (matches && (matches.length === 3)) {
                const productId = matches[1];
                const variationId = matches[2];
                productData.products.push({
                  productId,
                  variationId,
                  quantity: 1,
                });
                productData.includesFreeTrial = true;
              }
            }
          });
        } else {
          const totalPrice =
            R.multiply(+lineItem.price, lineItem.quantity);
          const totalDiscountedPrice =
            R.subtract(totalPrice, +lineItem.total_discount);
          const discountPercent = R.subtract(
            100,
            R.multiply(R.divide(totalDiscountedPrice, totalPrice), 100),
          );
          productData.products.push({
            productId: lineItem.product_id,
            variationId: lineItem.variant_id,
            quantity: lineItem.quantity,
            discountPercent,
          });
        }
      });
    }
    return productData;
  },

  _prepareCustomer(orderData) {
    const customer = {};
    if (orderData && orderData.customer) {
      customer.externalId = orderData.customer.id;
      customer.email = orderData.customer.email;
      customer.firstName = orderData.customer.first_name;
      customer.lastName = orderData.customer.last_name;

      try {
        const savedCustomer =
          CustomersCollection.findOne({ email: customer.email });
        if (savedCustomer && savedCustomer.stripeCustomerId) {
          customer.stripeCustomerId = savedCustomer.stripeCustomerId;
        } else {
          customer.stripeCustomerId =
            StripeHelper.findCustomerId(customer.email);
        }
      } catch (error) {
        bugsnag.notify(error, {
          message: 'Problem getting customer ID from Stripe',
          customer,
        });
      }

      if (!customer.stripeCustomerId) {
        const error = new Error(
          'Problem getting customer ID from Stripe; subscription ' +
          'will not be created.'
        );
        bugsnag.notify(error, { customer });
        throw error;
      }
    }
    return customer;
  },

  _prepareShippingMethod(orderData) {
    const shippingMethod = {};
    if (orderData
        && orderData.shipping_lines
        && orderData.shipping_lines.length > 0) {
      const shippingLine = orderData.shipping_lines[0];
      shippingMethod.shippingMethodId = shippingLine.id;
      shippingMethod.shippingMethodName = shippingLine.title;
      shippingMethod.shippingCost = shippingLine.price;
    }
    return shippingMethod;
  },

  _prepareOrder(orderData) {
    const order = {};
    if (orderData) {
      order.orderId = orderData.id;
      order.orderTypeId = 'new';
      order.orderDate = orderData.created_at;
      order.totalPrice = orderData.total_price;
    }
    return order;
  },
};

export default Subscription;
