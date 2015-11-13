// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var idCounter = 0;

var messageListener = function (template, event) {
  if (event.origin !== window.location.protocol + "//" + makeWildcardHost("payments")) {
    return;
  }

  if (event.data.id != template.id) {
    return;
  }

  if (event.data.showPrompt) {
    template.promptChoice.set(event.data.plan);
    return;
  }

  if (event.data.token) {
    var updateData = {
      email: event.data.token.email,
      subscription: event.data.plan
    };
    Meteor.call("createUserSubscription", event.data.token.id,
                event.data.token.email, event.data.plan, function (err, source) {
      if (err) {
        alert(err); // TODO(soon): make this UI better);
        return;
      }

      StripeCustomerData.upsert({_id: '0'}, updateData);
      if (source) StripeCards.upsert({_id: source.id}, source);
      template.eventuallyCheckConsistency();

      if (template.data.onComplete) {
        template.data.onComplete(true);
      }
    });
  }

  if (event.data.error || event.data.token) {
    template.promptChoice.set(null);
  }
};

Template.billingPrompt.helpers({
  onDismiss: function () {
    var self = this;
    return function () {
      if (self.onComplete) self.onComplete(false);
      return "remove";
    }
  }
});

Template._billingPromptPopup.onCreated(function () {
  this._oldPlan = Meteor.user().plan || "free";
  this._isComplete = new ReactiveVar(false);
});

Template._billingPromptBody.onCreated(function () {
  this.showFullscreen = new ReactiveVar(null);
  this.promptChoice = new ReactiveVar(null);  // which checkout iframe was clicked
  this.listener = messageListener.bind(this, this);
  this.id = idCounter++;
  window.addEventListener("message", this.listener, false);

  this.checkoutPlan = new ReactiveVar(null);
  this.isSelectingPlan = new ReactiveVar(null);
  this.subscribe("stripeCustomerData");
  this.subscribe("plans");
  updateStripeData();

  this.eventuallyCheckConsistency = function () {
    // After a few seconds, refresh stripe data from the server. If this method is called again
    // before the refresh, it pushes back the timeout.
    //
    // This is meant to catch problems in our ad hoc client-side cache. The update shouldn't ever
    // lead to changes if things are working correctly.

    if (this.eventualTimeout) {
      Meteor.clearTimeout(this.eventualTimeout);
    }
    var self = this;
    this.eventualTimeout = Meteor.setTimeout(function () {
      delete self.eventualTimeout;
      updateStripeData();
    }, 2000);
  }
});

Template._billingPromptBody.onDestroyed(function () {
  window.removeEventListener("message", this.listener, false);
});

Template.billingUsage.onCreated(function () {
  this.subscribe("getMyUsage");
  this._showPrompt = new ReactiveVar(false);
});

Template.billingUsage.helpers({
  showPrompt: function () {
    return Template.instance()._showPrompt.get();
  },
  promptClosed: function () {
    var v = Template.instance()._showPrompt;
    return function () {
      v.set(false);
    };
  }
});

Template.billingUsage.events({
  "click .change-plan": function (event, template) {
    event.preventDefault();
    template._showPrompt.set(true);
  }
});

function clickPlanHelper(context, ev) {
  var template = Template.instance();
  var planName = context._id;

  if (context.isCurrent && ((Meteor.user().plan || "free") === planName)) {
    // Clicked on current plan. Treat as dismiss.
    template.data.onComplete(false);
    return;
  }

  var data = StripeCards.find();
  if (data.count() > 0 || context.price === 0) {
    template.isSelectingPlan.set(planName);
    Meteor.call("updateUserSubscription", planName, function (err) {
      if (err) {
        alert(err); // TODO(soon): make this UI better;
        return;
      }

      // Non-error return means the plan was updated successfully, so update our client-side copy.
      StripeCustomerData.update("0", {$set: {subscription: planName }});
      template.isSelectingPlan.set(null);

      template.eventuallyCheckConsistency();

      if (template.data.onComplete) {
        template.data.onComplete(true);
      }
    });
  } else {
    var frame = ev.currentTarget.querySelector("iframe");
    frame.contentWindow.postMessage({openDialog: true}, "*");
  }
}

Template._billingPromptPopup.events({
  "click .continue": function (ev) {
    if (this.onComplete) {
      this.onComplete(true);
    }
  }
});

Template._billingPromptBody.events({
  "click .subscription": function (ev) {
    clickPlanHelper(this, ev);
  }
});

var helpers = {
  isFullscreen: function () {
    return Template.instance().promptChoice.get() === this._id;
  },
  checkoutData: function () {
    var title = this._id.charAt(0).toUpperCase() + this._id.slice(1);
    var primaryEmail = _.findWhere(SandstormDb.getUserEmails(Meteor.user()), {primary: true});
    if (!primaryEmail) return;

    // Firefox will apparently automatically do some URI encoding if we don't do it ourselves.
    // Other browsers won't. Meanwhile Firefox used to also do some automatic decoding on the
    // other end, but stopped in v41 to become consistent with other browsers.
    return encodeURIComponent(JSON.stringify({
      name: 'Sandstorm Oasis',
      description: title + " Plan",
      amount: this.price,
      panelLabel: "{{amount}} / Month",
      id: Template.instance().id,
      planName: this._id,
      email: primaryEmail.email,
    }));
  },
  plans: function () {
    var plans = this.db.listPlans().fetch();
    var data = StripeCustomerData.findOne();
    var myPlanName = (data && data.subscription) || "unknown";
    var myPlan;
    plans.forEach(function (plan) {
      if (plan._id === myPlanName) myPlan = plan;
    });
    plans.forEach(function (plan) {
      if (plan._id === myPlanName) {
        plan.isCurrent = true;
      } else {
        plan.isUpgrade = !myPlan || plan.price > myPlan.price;
      }
    });
    return plans;
  },
  renderCu: function (n) {
    return Math.floor(n / 1000000 / 3600);
  },
  renderDollars: function (price) {
    return Math.floor(price / 100);
  },
  renderStorage: function (size, additionalSize) {
    // Taking two parameters allows us to pass the referral bonus
    // storage amount on the client side and use this function to
    // add & format them together.
//    debugger;
    if (typeof additionalSize === "number") {
      size += additionalSize;
    }
    var suffix = "B";
    if (size >= 1000000000) {
      size = size / 1000000000;
      suffix = "GB";
    } else if (size >= 1000000) {
      size = size / 1000000;
      suffix = "MB";
    } else if (size >= 1000) {
      size = size / 1000;
      suffix = "kB";
    }
    return Math.floor(size) + suffix;
  },
  renderStoragePrecise: function (size) {
    var suffix = "B";
    if (size >= 1000000000) {
      size = size / 1000000000;
      suffix = "GB";
    } else if (size >= 1000000) {
      size = size / 1000000;
      suffix = "MB";
    } else if (size >= 1000) {
      size = size / 1000;
      suffix = "kB";
    }
    return size.toPrecision(3) + suffix;
  },
  renderQuantity: function (n) {
    return (n === Infinity) ? "Unlimited" : n.toString();
  },
  renderPercent: function (num, denom) {
    return Math.min(100, Math.max(0, num / denom * 100)).toPrecision(3);
  },
  isSelecting: function () {
    return Template.instance().isSelectingPlan.get() === this._id;
  },
  paymentsUrl: function () {
    return window.location.protocol + "//" + makeWildcardHost("payments");
  },
  involuntary: function () { return this.reason && this.reason !== "voluntary"; },
  outOfGrains: function () { return this.reason === "outOfGrains"; },
  outOfStorage: function () { return this.reason === "outOfStorage"; },
  outOfCompute: function () { return this.reason === "outOfCompute"; },
  customApp: function () { return this.reason === "customApp"; },
  origin: function () { return document.location.protocol + "//" + document.location.host; },
  isDemoUser: function () {
    return this.db.isDemoUser();
  },
  myPlan: function () {
    return this.db.getMyPlan();
  },
  myUsage: function () {
    return this.db.getMyUsage();
  },
  myReferralBonus: function() {
    var x = this.db.getMyReferralBonus();
    if (Meteor.user().pseudoReferralBonus) {
      alert(JSON.stringify(x));
    }
    return x;
  },
  onCompleteWrapper: function () {
    var template = Template.instance();
    return function (success) {
      if (success) {
        template._isComplete.set(true);
      } else {
        template.data.onComplete(false);
      }
    }
  },
  isComplete: function () {
    return Template.instance()._isComplete.get();
  },
  oldPlan: function () {
    return Template.instance()._oldPlan;
  },
  isShowingIframe: function () {
    var data = StripeCards.find();
    return this.price && !this.isCurrent && data.count() === 0;
  }
};

Template._billingPromptBody.helpers(helpers);
Template._billingPromptPopup.helpers(helpers);
Template.billingUsage.helpers(helpers);
